import { ALL_FLOAT_TYPES, SCALAR_TYPES } from "../../built_in_types.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import type Type from "../../nodes/Type.ts";
import collect_var_refs from "./collect_var_refs.ts";

/**
 * Whole-function register allocation (ASM_PLAN phase 4).
 *
 * Before a function body is built, scan its AST once and reserve callee-saved
 * registers for the hottest scalar LOCALS and PARAMS for the ENTIRE function:
 * every read/write of a promoted variable hits the register instead of an
 * `ldr/str [x29, #off]` pair, with no loop-entry load / loop-exit store
 * brackets (the per-loop promotion in build_for_loop_node /
 * build_while_loop_node remains for loop-local hotness the function-level
 * pass doesn't capture).
 *
 * Soundness model:
 * - Callee-saved registers (x23-x28, d8-d15) survive calls, so a promoted
 *   value is live across `bl` without spilling. The prologue/epilogue save +
 *   restore machinery keys off `status.callee_saved_regs_used`, which this
 *   pass seeds before the body build; loops and Buffer data-pointer caches
 *   claim registers from the same pool minus these.
 * - The binding is seeded into `status.register_allocations` BEFORE the body
 *   builds, so the variable's declaration initializer (emit_var_store),
 *   assignments, and reads all move through the register-aware paths. The
 *   stack slot still allocated by the declaration stays as a dead home slot
 *   (emit_var_address flushes the register to it before any address-take).
 * - Promoted PARAMS initialize their register in the prologue instead of
 *   spilling to the home slot: `mov xN, xArg` / `fmov dN, xArg` (8-byte
 *   params), or the ordinary spill plus a width-aware load for sub-word
 *   params (the slot load zero-extends exactly like a body read would).
 * - ESCAPES exclude a variable or param from promotion:
 *   - passed to a `ref` parameter anywhere in the function (the callee may
 *     write the caller's slot through the pointer; the register copy would go
 *     stale). The checker stamps `ref_param_indices` on call nodes, so this
 *     is detected syntactically.
 *   - its address taken / used as an access target (collect_var_refs).
 *   - the name is declared more than once anywhere in the function (shadowed
 *     declarations would share the register) or — for a local — collides
 *     with a parameter of the function.
 *   - (params) not a clean scalar type: array/view/ref/nullable modifiers,
 *     variadic, and fat `string` pair-ABI params all keep their existing
 *     conventions; struct/trait/enum/class params ride the x19-x22 pool.
 * - Sub-word scalars (bool/char/int8/int16/int32) are promoted like the loop
 *   pass: all register traffic is full-width `mov`s of already zero-extended
 *   values, and the declaration's `emit_var_store` initializes the register
 *   directly (no sub-word slot load is ever needed).
 *
 * Caps deliberately leave registers for the loop pass and Buffer data caches
 * (x27/x28 + d12-d15) so inner-loop codegen doesn't regress.
 */

const X_POOL = ["x23", "x24", "x25", "x26", "x27", "x28"];
const D_POOL = ["d8", "d9", "d10", "d11", "d12", "d13", "d14", "d15"];
/** Whole-function promotion caps; the rest of the pools stay available to
 *  loop promotion and Buffer data-pointer caches. */
const MAX_X_REGS = 4;
const MAX_D_REGS = 4;
/** A whole-function promotion amortizes its prologue save + epilogue restore
 *  across every use in the function; below this many reads it rarely pays. */
const MIN_READS = 4;

interface Candidate {
	name: string;
	reads: number;
	type_name: string;
}

/**
 * Plan whole-function promotions for a function body. Returns a fresh
 * name→register map (empty when nothing is worth promoting); the caller seeds
 * it into `status.register_allocations` and `status.callee_saved_regs_used`
 * before building the body. Params and locals compete for the same register
 * pools, hottest first.
 */
export function plan_function_promotions(func: {
	params: { name: string; type: Type; is_variadic?: boolean }[];
	statements: BaseNode[];
}): Map<string, string> {
	const decl_types = new Map<string, string>();
	const decl_counts = new Map<string, number>();
	const ref_arg_names = new Set<string>();

	for (const stmt of func.statements) {
		scan(stmt, decl_types, decl_counts, ref_arg_names);
	}

	// Read counts / access-target marks, merged across the body (same source
	// the loop pass uses, so the two heuristics count identically).
	const reads = new Map<string, number>();
	const address_taken = new Set<string>();
	for (const stmt of func.statements) {
		for (const [name, info] of collect_var_refs(stmt)) {
			reads.set(name, (reads.get(name) ?? 0) + info.reads);
			if (info.address_taken) address_taken.add(name);
		}
	}

	const param_names = new Set(func.params.map((p) => p.name));
	const candidates: Candidate[] = [];
	for (const [name, type_name] of decl_types) {
		if ((decl_counts.get(name) ?? 0) !== 1) continue; // shadowed anywhere
		if (param_names.has(name)) continue; // would collide with a param slot
		if (ref_arg_names.has(name)) continue; // callee may write the slot
		if (address_taken.has(name)) continue;
		const r = reads.get(name) ?? 0;
		if (r < MIN_READS) continue;
		candidates.push({ name, reads: r, type_name });
	}
	// Scalar params are promotion candidates too: the value arrives in a
	// param register (or overflow slot) and would otherwise be spilled to a
	// frame slot that every body read reloads. Struct-ish params keep their
	// x19-x22 callee-saved pool; only clean scalars take this path.
	for (const param of func.params) {
		if (param.is_variadic) continue;
		const t = param.type;
		if (!t?.name || !SCALAR_TYPES.includes(t.name)) continue;
		if (t.is_array || t.is_view || t.is_ref || t.is_nullable) continue;
		if ((decl_counts.get(param.name) ?? 0) !== 0) continue; // shadowed by a body decl
		if (ref_arg_names.has(param.name)) continue; // callee may write the slot
		if (address_taken.has(param.name)) continue;
		const r = reads.get(param.name) ?? 0;
		if (r < MIN_READS) continue;
		candidates.push({ name: param.name, reads: r, type_name: t.name });
	}
	if (candidates.length === 0) return new Map();

	candidates.sort((a, b) => b.reads - a.reads);
	const result = new Map<string, string>();
	let x_used = 0;
	let d_used = 0;
	for (const c of candidates) {
		if (ALL_FLOAT_TYPES.includes(c.type_name)) {
			if (d_used >= MAX_D_REGS) continue;
			result.set(c.name, D_POOL[d_used++]);
		} else {
			if (x_used >= MAX_X_REGS) continue;
			result.set(c.name, X_POOL[x_used++]);
		}
	}
	return result;
}

/**
 * Generic AST walk collecting declaration sites and `ref`-argument escapes.
 * Descends through every object key (except parent/scope links) so nothing is
 * missed; nested function bodies are included, which can only make the
 * shadow/ref exclusions more conservative (their reads don't affect this
 * scan's eligibility, only the collect_var_refs counts do).
 */
function scan(
	node: BaseNode | null | undefined,
	decl_types: Map<string, string>,
	decl_counts: Map<string, number>,
	ref_arg_names: Set<string>,
) {
	if (!node || typeof node !== "object") return;
	const any_node = node as any;

	if (any_node.node_type === "declare") {
		const decl = node as DeclarationNode;
		if (decl.name) {
			decl_counts.set(decl.name, (decl_counts.get(decl.name) ?? 0) + 1);
			// Only record promotable scalar types (no array/view/ref/nullable
			// modifiers) — names without a recorded type are never candidates.
			const t = decl.type;
			if (
				t?.name &&
				SCALAR_TYPES.includes(t.name) &&
				!t.is_array &&
				!t.is_view &&
				!t.is_ref &&
				!t.is_nullable
			) {
				decl_types.set(decl.name, t.name);
			}
		}
	}

	if (any_node.node_type === "func_call" || any_node.node_type === "access_func") {
		const ref_indices: number[] | undefined = any_node.ref_param_indices;
		if (ref_indices?.length && Array.isArray(any_node.params)) {
			for (const i of ref_indices) {
				const arg = any_node.params[i];
				if (arg?.node_type === "value" && typeof arg.value === "string") {
					ref_arg_names.add(arg.value);
				}
			}
		}
	}

	for (const key of Object.keys(any_node)) {
		if (key === "parent" || key === "scope") continue;
		const val = any_node[key];
		if (Array.isArray(val)) {
			for (const item of val) scan(item, decl_types, decl_counts, ref_arg_names);
		} else if (val && typeof val === "object" && typeof val.node_type === "string") {
			scan(val, decl_types, decl_counts, ref_arg_names);
		}
	}
}
