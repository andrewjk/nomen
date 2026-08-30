import type BuildStatus from "../../build_c/BuildStatus.ts";
import { ALL_FLOAT_TYPES, SCALAR_TYPES } from "../../built_in_types.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import collect_var_refs, { collect_declared_names } from "./collect_var_refs.ts";
import { emit_promoted_load } from "./stack_var.ts";

/**
 * Shared per-loop register promotion (ASM_PLAN phase 4).
 *
 * This is the promotion core that used to live duplicated inline in
 * build_while_loop_node and build_for_loop_node (~110 identical lines each):
 * scan the loop's condition/body/update for variable traffic, and reserve
 * callee-saved registers for the hottest scalar locals (reads >= 3, never
 * address-taken, never redeclared in the loop body, not already claimed by
 * the whole-function allocator). Each promotion emits its width-aware
 * `emit_promoted_load` immediately (loop-entry cache fill) and the caller is
 * responsible for the loop-exit `emit_promoted_store` write-backs plus the
 * `register_allocations` snapshot/restore.
 *
 * Register-class bookkeeping is split by pool: a d-register claimed by an
 * enclosing loop's promotion or a Buffer data-pointer cache must block the
 * FLOAT pool, not just the x pool.
 */

const CALLEE_SAVED_REGS = ["x23", "x24", "x25", "x26", "x27", "x28"];
const FLOAT_CALLEE_SAVED = ["d8", "d9", "d10", "d11", "d12", "d13", "d14", "d15"];

export interface PromotedVar {
	name: string;
	reg: string;
	offset: number;
	type_name: string;
}

/**
 * Value-node names assigned in this statement subtree (`x = …`, `x += …`,
 * `obj.f = …` assigns the object root's field — the ROOT name counts as a
 * write for promotion purposes only when it's a plain value target).
 */
function collect_assign_targets(node: BaseNode, out: Set<string>): void {
	if (!node || typeof node !== "object") return;
	const n = node as unknown as Record<string, unknown>;
	if (n.node_type === "assign" || n.node_type === "assign_decl") {
		const left = n.left_value as BaseNode | undefined;
		if (left && left.node_type === "value") {
			const v = (left as unknown as { value: string }).value;
			if (v && v !== "null" && !v.startsWith('"')) out.add(v);
		}
	}
	for (const key of Object.keys(n)) {
		if (key === "parent" || key === "scope") continue;
		const v = n[key];
		if (Array.isArray(v)) {
			for (const item of v) {
				if (item && typeof item === "object" && "node_type" in (item as object)) {
					collect_assign_targets(item as BaseNode, out);
				}
			}
		} else if (v && typeof v === "object" && "node_type" in (v as object)) {
			collect_assign_targets(v as BaseNode, out);
		}
	}
}

/**
 * Promote the loop's hottest variables and emit their entry loads. Mutates
 * `status.register_allocations` (creating the map when absent) and seeds
 * `status.callee_saved_regs_used` with every claimed register. Returns the
 * promoted bindings in promotion order — the caller emits the matching
 * store-backs at loop exit.
 */
export function promote_loop_locals(
	status: BuildStatus,
	scoped_declarations: DeclarationNode[],
	sources: { condition?: BaseNode; statements: BaseNode[]; update?: BaseNode | null },
): PromotedVar[] {
	const promoted: PromotedVar[] = [];
	const all_refs = new Map<string, { reads: number; address_taken: boolean }>();

	const merge_refs = (refs: Map<string, { reads: number; address_taken: boolean }>) => {
		for (const [name, info] of refs) {
			const existing = all_refs.get(name);
			if (existing) {
				existing.reads += info.reads;
				if (info.address_taken) existing.address_taken = true;
			} else {
				all_refs.set(name, {
					reads: info.reads,
					address_taken: info.address_taken,
				});
			}
		}
	};

	if (sources.condition) {
		merge_refs(collect_var_refs(sources.condition));
	}
	for (const stmt of sources.statements) {
		merge_refs(collect_var_refs(stmt));
	}
	if (sources.update) {
		merge_refs(collect_var_refs(sources.update));
	}

	const eligible: {
		name: string;
		reads: number;
		offset: number;
		type_name: string;
	}[] = [];
	const redeclared = collect_declared_names({
		node_type: "block",
		statements: sources.statements,
	} as any);
	// Accumulator-aware eligibility (ASM_PLAN_2 tranche D): a variable
	// WRITTEN in the loop body is a loop-carried accumulator/induction —
	// its slot round-trips execute every iteration even when the TEXT has
	// a single read (e.g. `var a = 0.0` read once as `a = a + …`). Those
	// qualify with reads >= 1; everything else keeps the reads >= 3 bar.
	const body_writes = new Set<string>();
	for (const stmt of sources.statements) {
		collect_assign_targets(stmt, body_writes);
	}
	for (const [name, info] of all_refs) {
		const is_accumulator = body_writes.has(name) && info.reads >= 1;
		if (info.reads < 3 && !is_accumulator) continue;
		if (info.address_taken) continue;
		if (redeclared.has(name)) continue;
		// Aliasing-aware exclusions (critical for accumulator eligibility —
		// a promoted alias/ref breaks write-through semantics):
		if (status.function_ref_params?.has(name)) continue;
		if (status.function_ref_params?.has(`&${name}`)) continue;
		if (status.heap_strings?.has(name)) continue;
		if (status.class_alias_vars?.has(name)) continue;
		if (status.ref_class_slots?.has(name)) continue;
		if (status.heap_array_vars?.has(name)) continue;
		if (status.function_struct_param_slots?.has(name)) continue;
		const offset = status.stack_offsets?.get(name);
		if (offset === undefined) continue;
		if (status.register_allocations?.has(name)) continue;
		const decl = scoped_declarations.find((d) => d.name === name);
		let type_name = "";
		if (decl) {
			type_name = decl.type?.name || "";
			if (!SCALAR_TYPES.includes(type_name)) continue;
		}
		eligible.push({ name, reads: info.reads, offset, type_name });
	}

	eligible.sort((a, b) => b.reads - a.reads);

	if (!status.register_allocations) {
		status.register_allocations = new Map();
	}

	const used_regs = new Set(status.register_allocations.values());
	const used_x = new Set<string>();
	const used_d = new Set<string>();
	for (const r of used_regs) {
		if (r.startsWith("d")) used_d.add(r);
		else used_x.add(r);
	}
	// Avoid callee-saved registers already claimed by an enclosing loop's
	// promoted variables or Buffer data-pointer caches — reusing one would
	// clobber the outer loop's value across this loop's body. Split by
	// register class so a claimed d-register actually blocks the float
	// pool (adding every name to used_x left d8-d15 claims invisible to
	// the FLOAT_CALLEE_SAVED scan).
	if (status.callee_saved_regs_used) {
		for (const r of status.callee_saved_regs_used) {
			if (r.startsWith("d")) used_d.add(r);
			else used_x.add(r);
		}
	}
	let x_idx = 0;
	let d_idx = 0;
	for (const v of eligible) {
		const is_float = ALL_FLOAT_TYPES.includes(v.type_name);
		if (is_float) {
			while (d_idx < FLOAT_CALLEE_SAVED.length && used_d.has(FLOAT_CALLEE_SAVED[d_idx])) {
				d_idx++;
			}
			if (d_idx >= FLOAT_CALLEE_SAVED.length) continue;
			const reg = FLOAT_CALLEE_SAVED[d_idx];
			status.register_allocations.set(v.name, reg);
			used_d.add(reg);
			promoted.push({
				name: v.name,
				reg,
				offset: v.offset,
				type_name: v.type_name,
			});
			// The cached register must be loaded with the slot's width —
			// bool/char/int8 slots are 1-byte strb stores, so a full-width
			// `ldr` would pull dirty stack bytes into the cache.
			emit_promoted_load(status, reg, v.offset, v.type_name);
			d_idx++;
		} else {
			while (x_idx < CALLEE_SAVED_REGS.length && used_x.has(CALLEE_SAVED_REGS[x_idx])) {
				x_idx++;
			}
			if (x_idx >= CALLEE_SAVED_REGS.length) continue;
			const reg = CALLEE_SAVED_REGS[x_idx];
			status.register_allocations.set(v.name, reg);
			used_x.add(reg);
			promoted.push({
				name: v.name,
				reg,
				offset: v.offset,
				type_name: v.type_name,
			});
			emit_promoted_load(status, reg, v.offset, v.type_name);
			x_idx++;
		}
	}

	if (promoted.length > 0) {
		if (!status.callee_saved_regs_used) {
			status.callee_saved_regs_used = new Set();
		}
		for (const p of promoted) {
			status.callee_saved_regs_used.add(p.reg);
		}
	}

	return promoted;
}
