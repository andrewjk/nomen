/**
 * Naked inline expansion for allocation-free leaf bodies — CORE_RAW.md's
 * revisit condition: "Revisit if the inline splice path ever learns to
 * emit naked bodies for allocation-free unsafe snippets."
 *
 * For a small class of bodies — straight-line, call-free, only scalar/ptr
 * value shapes — this compiles the plain-Nomen body directly to the
 * STANDALONE raw-block convention (x19 = self, first non-self arg → x1,
 * second → x2, …; result → x0). The existing `build_naked_inline` machinery
 * then adapts it to the splice site exactly like a hand-written raw body:
 * a single x19 read is rewritten to x0, more become a save/park/restore
 * prologue+epilogue, and `.L` labels get per-site suffixes.
 *
 * The payoff: for BigInt's limb accessors the compiled body is
 * instruction-identical to the hand-written raw blocks —
 *
 *     get:     ldr x9, [x19, #OFF]; ldr x0, [x9, x1, lsl #3]
 *     set:     ldr x9, [x19, #OFF]; str x2, [x9, x1, lsl #3]
 *     get_at:  ldr x0, [x1, x2, lsl #3]
 *     set_at:  str x3, [x1, x2, lsl #3]
 *
 * — so the unsafe-Nomen forms cost the same as raw and the raw asm pairs
 * can be deleted (single-sourced, both backends; the C backend was already
 * identical because clang inlines these).
 *
 * v1 whitelist per body:
 * - ≤ 4 statements, each a `ptr T` local declaration with initializer, an
 *   index store (`p[i] = expr`), or a `return <expr>`
 * - expressions: parameter references, small non-negative integer
 *   literals, `self.f` / `self.f.g` field chains (value-struct hops,
 *   flattened to one load), `as ptr T` / `as uint64` casts, `p[i]` loads
 * - locals ≤ 2, register-allocated to x9/x10 — never stack slots
 * - instance methods only (self → x19; static bodies would shift the arg
 *   registers), at most 3 non-self params
 * Anything else returns null; the caller falls back to the general splice.
 */

import type BuildStatus from "../build_c/BuildStatus.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import IndexNode from "../nodes/IndexNode.ts";
import type Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { pointer_element_size } from "./utils/ptr_access.ts";
import { get_field_offset } from "./utils/struct_layout.ts";

const NAKED_MAX_STATEMENTS = 4;
const NAKED_SCRATCH = ["x9", "x10"];

/** Byte size of a pointer element — must be a power of two ≤ 8 to be naked. */
function naked_element_scale(type: Type, status: BuildStatus): number | null {
	const size = pointer_element_size(type, status);
	if (![1, 2, 4, 8].includes(size)) return null;
	return Math.log2(size);
}

/** A `value` node naming a plain identifier. */
function ident_of(node: BaseNode): string | null {
	if (node.node_type !== "value") return null;
	const name = (node as ValueNode).value;
	return typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
}

/** Per-body emission context. */
class NakedCtx {
	lines: string[] = [];
	homes = new Map<string, string>();
	locals = new Map<string, string>();
	scratch_idx = 0;

	constructor(
		func: FunctionNode,
		public struct_name: string,
		public status: BuildStatus,
	) {
		this.homes.set("self", "x19");
		let n = 0;
		for (const p of func.params) {
			if (p.is_self_param) continue;
			this.homes.set(p.name, `x${++n}`);
		}
	}

	scratch(): string | null {
		return this.scratch_idx < NAKED_SCRATCH.length ? NAKED_SCRATCH[this.scratch_idx++] : null;
	}

	push(line: string): boolean {
		this.lines.push(line);
		return true;
	}
}

/** Compile the body to standalone-convention asm, or null to refuse. */
export function extract_nomen_naked_asm(
	func: FunctionNode,
	struct_name: string,
	status: BuildStatus,
): string | null {
	const refuse = (_why: string): null => null;
	if (!func.has_body) return null;
	const params = func.params;
	if (!params.some((p) => p.is_self_param)) return null; // instance methods only
	const non_self = params.filter((p) => !p.is_self_param);
	if (non_self.length > 3) return null;

	const ctx = new NakedCtx(func, struct_name, status);
	const stmts = func.statements;
	if (stmts.length === 0 || stmts.length > NAKED_MAX_STATEMENTS) return null;

	for (const stmt of stmts) {
		if (stmt.node_type === "declare") {
			const d = stmt as DeclarationNode;
			if (!d.type?.is_pointer) return refuse(`declare ${d.name}: not ptr (is_pointer unset)`);
			if (!d.value) return refuse("declare: no init");
			if (!d.value) return null;
			const reg = ctx.scratch();
			if (!reg) return refuse("out of scratch");
			ctx.locals.set(d.name, reg);
			if (!emit_naked_expr(d.value, reg, ctx)) return null;
		} else if (stmt.node_type === "return") {
			const value = (stmt as unknown as { value?: BaseNode }).value;
			if (!value) return null; // bare return refused (x0 must carry a value)
			if (!emit_naked_expr(value, "x0", ctx)) return null;
		} else if (stmt.node_type === "assign") {
			const left = (stmt as unknown as { left_value: BaseNode }).left_value;
			const right = (stmt as unknown as { right_value?: BaseNode }).right_value;
			if (!left || left.node_type !== "index") return null;
			const idx_node = left as IndexNode;
			if (!idx_node.type) return null;
			const base_name = ident_of(idx_node.target);
			const base_reg = base_name ? ctx.locals.get(base_name) : undefined;
			if (!base_reg) return null; // store base must be a naked local
			const scale = naked_element_scale(idx_node.type, ctx.status);
			if (scale === null) return null;
			// Value: a bare param name reads its home register (zero
			// instructions); anything else goes through a scratch.
			if (!right) return null;
			const val_name = ident_of(right);
			let val_reg: string | undefined = val_name
				? (ctx.homes.get(val_name) ?? undefined)
				: undefined;
			let value_lines: string[] = [];
			if (!val_reg) {
				val_reg = ctx.scratch() ?? undefined;
				if (!val_reg) return null;
				const mark = ctx.lines.length;
				if (!emit_naked_expr(right, val_reg, ctx)) return null;
				value_lines = ctx.lines.splice(mark);
			}
			const idx_name = ident_of(idx_node.index);
			const idx_reg = idx_name ? ctx.homes.get(idx_name) : undefined;
			if (!idx_reg) return null; // index must be a param (the raw convention)
			const shift = scale > 0 ? `, lsl #${scale}` : "";
			ctx.lines.push(...value_lines);
			ctx.lines.push(`str ${val_reg}, [${base_reg}, ${idx_reg}${shift}]`);
		} else {
			return null;
		}
	}
	return ctx.lines.join("\n");
}

/** Expression compiler: emit `node` into `dst`, or false to refuse. */
function emit_naked_expr(node: BaseNode, dst: string, ctx: NakedCtx): boolean {
	if (!node) return false;
	const nt = node.node_type;
	if (nt === "value") {
		const name = ident_of(node);
		if (name !== null) {
			const home = ctx.homes.get(name) ?? ctx.locals.get(name);
			if (!home) return false;
			if (home !== dst) ctx.push(`mov ${dst}, ${home}`);
			return true;
		}
		const raw = (node as ValueNode).value;
		if (typeof raw === "string" && /^\d+$/.test(raw) && Number(raw) <= 65535) {
			ctx.push(`mov ${dst}, #${raw}`);
			return true;
		}
		return false;
	}
	if (nt === "cast") {
		// Integer↔pointer casts are register no-ops at machine width.
		const inner = (node as unknown as { value: BaseNode }).value;
		return emit_naked_expr(inner, dst, ctx);
	}
	if (nt === "access") {
		// `self.f` / `self.f.g` — flattened field-chain load from x19.
		const chain: string[] = [];
		let cur: BaseNode = node;
		while (cur.node_type === "access") {
			const inner = (cur as unknown as { access?: BaseNode }).access;
			if (!inner || inner.node_type !== "access_field") return false;
			const hop = (inner as unknown as { name?: string }).name ?? null;
			if (!hop || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(hop)) return false;
			chain.unshift(hop);
			cur = (cur as unknown as { target: BaseNode }).target;
		}
		const root = ident_of(cur);
		if (root !== "self") return false;
		if (chain.length === 0 || chain.length > 2) return false;
		let struct_name = ctx.struct_name;
		let offset = 0;
		for (const hop of chain) {
			offset += get_field_offset(struct_name, hop, ctx.status);
			const next = field_type_of(struct_name, hop, ctx.status);
			if (next === null) return false;
			struct_name = next;
		}
		ctx.push(`ldr ${dst}, [x19, #${offset}]`);
		return true;
	}
	if (nt === "index") {
		const idx_node = node as IndexNode;
		const base_name = ident_of(idx_node.target);
		const base_reg = base_name ? ctx.locals.get(base_name) : undefined;
		if (!base_reg) return false; // load base must be a naked local
		if (!idx_node.type) return false;
		const scale = naked_element_scale(idx_node.type, ctx.status);
		if (scale === null) return false;
		const idx_name = ident_of(idx_node.index);
		const idx_reg = idx_name ? (ctx.homes.get(idx_name) ?? ctx.locals.get(idx_name)) : undefined;
		if (!idx_reg) return false;
		// scale IS log2(size): 3 → lsl #3 (8 bytes), 2 → lsl #2 (4), …
		const shift = scale > 0 ? `, lsl #${scale}` : "";
		ctx.push(`ldr ${dst}, [${base_reg}, ${idx_reg}${shift}]`);
		return true;
	}
	return false;
}

function field_type_of(
	struct_name: string,
	field_name: string,
	status: BuildStatus,
): string | null {
	const struct = status.structs.find((s) => s.name === struct_name);
	const field = struct?.fields.find((f) => f.name === field_name);
	return field?.type?.name ?? null;
}
