import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { is_identifier_like } from "../nir/from_ast.ts";
import type { NirExpr, NirStmt } from "../nir/nir.ts";
import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type DeclarationNode from "../nodes/DeclarationNode.ts";
import type GroupedNode from "../nodes/GroupedNode.ts";
import type OperationNode from "../nodes/OperationNode.ts";
import type RangeNode from "../nodes/RangeNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import aarch64_size from "./utils/aarch64_size.ts";

/**
 * NEON loop-vectorization planning over the NIR (ASM_PLAN phase 4) — the
 * detection half of the vectorizer. `plan_vector_loop` (while-shaped) and
 * `plan_vector_for` (range-shaped) pattern-match the canonical count-up
 * elementwise Buffer loop and return an emission plan, or null when ANY
 * soundness condition fails (the caller then emits the plain scalar loop,
 * byte-identical to the pre-vectorizer output).
 *
 * Pattern (all parts verified structurally before a plan is returned):
 *
 *   var i = 0                         ┐
 *   while i < N; i += 1 {             │ while form (init verified by a
 *     buf.store_T(i, expr)            │ backward scan)…
 *   }                                 ┘
 *   for i of 0 .. n {                 ← range form: the builder itself
 *     buf.store_T(i, expr)              initializes i to the (zero) start
 *   }                                   and steps it by one
 *
 * Element kinds (tranche 2): the method pair determines the descriptor —
 * `load_float`/`store_float` (f64, `.2d`), `load_int`/`store_int` (8-byte
 * int, `.2d`), `load`/`store` (4-byte int, `.4s`). All accesses in one
 * loop must agree on the descriptor; lanes per group follow the width.
 *
 * Soundness model (why this is legal):
 *
 * - ALIASING IS A NON-ISSUE BY CONSTRUCTION: every Buffer access in the
 *   loop (load or store, any buffer) uses EXACTLY the induction index, so
 *   a vector iteration touches the same element set the scalar iterations
 *   it replaces would. Lane k reads element base+k before lane k writes
 *   element base+k; no lane reads an element another lane writes, whatever
 *   buffers alias. This is why shifted indices (`load_float(i + 1)`) are
 *   rejected outright.
 * - TRIP SEMANTICS: the vector loop runs whole 16-byte groups (unrolled to
 *   two groups per iteration); the limit is floor(N / group) rounded down
 *   to a multiple of the unroll — floor semantics keep every lane index
 *   < N for ANY signed bound (negative → loop skipped). The ORIGINAL
 *   scalar loop is emitted unchanged afterwards as the tail (the induction
 *   is synced to the vector loop's exit counter first), covering the
 *   remainder — including the sub-unroll and negative-N cases where the
 *   vector loop exits immediately.
 * - NO REASSOCIATION: float reductions (`a = a + … * buf.load_float(i)`)
 *   would change summation order and are REJECTED — a name that is defined
 *   anywhere in the loop may only be read AFTER its defining statement in
 *   the same iteration (straight-line single-assignment temps). Integer
 *   `+`/`*`/bitwise reductions would be wrap-exact, but the same shape
 *   guard keeps one rule for all kinds (they remain future work).
 * - INT OPS ARE WRAP-EXACT: `+`/`-`/`*` on two's-complement lanes
 *   reproduce scalar wrap-around bit-for-bit; `&`/`|`/`^` are lane-wise
 *   identical. Integer `/`/`%` have no NEON form and reject.
 * - TEMPS NEVER ESCAPE: per-lane temps live in v-registers inside the
 *   vector loop; the scalar tail re-declares them into their own slots. A
 *   temp read anywhere AFTER the loop in the enclosing statement list
 *   would observe the last tail iteration's value when the tail runs but
 *   stale bytes when it doesn't (zero tail iterations) — such reads reject
 *   the plan.
 * - NO OTHER EFFECTS: the body may contain only scalar temp declares /
 *   assigns and store evals — no calls, no control flow, no ref args, no
 *   swaps, no raw blocks — so there is nothing the vector loop could
 *   reorder, skip, or duplicate.
 * - The bound N is a leaf variable or integer literal, is not defined
 *   anywhere in the loop, and (for literals) is at least MIN_TRIP — tiny
 *   fixed-trip loops stay scalar.
 */

/** Max distinct Buffers per plan — the preheader pins each data pointer in
 *  a dedicated scratch register (x11..x13). */
const MAX_BUFFERS = 3;
/** Max per-lane temps (v4..v7). */
const MAX_TEMPS = 4;
/** Max binary-op nesting depth in lane expressions (spill regs v14→v11). */
const MAX_OP_DEPTH = 4;
/** Max vector accumulators per plan (v2/v3). */
const MAX_REDUCTIONS = 2;
/** Literal bounds below this stay scalar (unrolled-vector overhead swamps
 *  a handful of iterations). Runtime bounds always vectorize. */
const MIN_TRIP = 8;

/**
 * Element descriptor — derived from the Buffer method pair. The 16-byte Q
 * access covers `group_elems` elements; `shift` = log2(group_elems) drives
 * both the limit computation and the induction sync.
 */
export interface ElemDesc {
	readonly load: "load_float" | "load_int" | "load";
	readonly store: "store_float" | "store_int" | "store";
	readonly float: boolean;
	/** Arrangement for add/sub/mul lanes. */
	readonly arr: "2d" | "4s";
	/** Elements per 16-byte group. */
	readonly group_elems: 2 | 4;
	/** log2(group_elems). */
	readonly shift: 1 | 2;
}

const ELEM_DESCS: readonly ElemDesc[] = [
	{ load: "load_float", store: "store_float", float: true, arr: "2d", group_elems: 2, shift: 1 },
	{ load: "load_int", store: "store_int", float: false, arr: "2d", group_elems: 2, shift: 1 },
	{ load: "load", store: "store", float: false, arr: "4s", group_elems: 4, shift: 2 },
];

/** Name-derived element class of a scalar temp/invariant, for consistency
 *  with the plan's descriptor (float vs 8-byte int vs 4-byte int). */
type ElemClass = "float" | "e8" | "e4";

function class_of_elem(elem: ElemDesc): ElemClass {
	return elem.float ? "float" : elem.group_elems === 2 ? "e8" : "e4";
}

function class_of_type_name(name: string | null | undefined): ElemClass | null {
	if (!name) return null;
	if (name === "float") return "float";
	try {
		const size = aarch64_size(name);
		if (size === 8) return "e8";
		if (size === 4) return "e4";
	} catch {
		// unknown type name — fall through
	}
	return null;
}

/** Operators legal on lanes per element kind. AArch64 NEON has NO 64-bit
 *  integer multiply (`mul` vector is 8/16/32-bit only), so `*` is restricted
 *  to the `.4s` kind; `/`/`%` have no NEON int form at all. */
function op_allowed(op: string, elem: ElemDesc): boolean {
	if (elem.float) return op === "+" || op === "-" || op === "*" || op === "/";
	if (op === "*") return elem.arr === "4s";
	return ["+", "-", "&", "|", "^"].includes(op);
}

export type NeonLaneExpr =
	/** `buf.load_float(i)` — `node` is the receiver (Buffer value) node. */
	| { readonly k: "load"; readonly buffer: string; readonly node: BaseNode }
	/** Float/int literal — emitted via the scalar float-operand path + dup. */
	| { readonly k: "lit"; readonly node: BaseNode }
	/** Loop-invariant float scalar (local/param never defined in the loop). */
	| { readonly k: "scalar"; readonly name: string; readonly node: BaseNode }
	/** Per-lane temp defined by an earlier statement of the same iteration. */
	| { readonly k: "temp"; readonly name: string }
	| {
			readonly k: "op";
			readonly op: "+" | "-" | "*" | "/" | "&" | "|" | "^";
			readonly left: NeonLaneExpr;
			readonly right: NeonLaneExpr;
	  };

export type NeonLaneStmt =
	| {
			readonly kind: "temp_def";
			readonly name: string;
			readonly value: NeonLaneExpr;
	  }
	| {
			readonly kind: "store";
			/** Buffer receiver name (plan dedupe key, buffer-reg selection). */
			readonly buffer: string;
			/** Buffer receiver node (data-pointer resolution at emission). */
			readonly buffer_node: BaseNode;
			readonly value: NeonLaneExpr;
	  }
	| {
			readonly kind: "reduction";
			/** The accumulator (a float local defined before the loop). */
			readonly name: string;
			readonly op: "+" | "*";
			readonly operand: NeonLaneExpr;
	  };

/** A vector accumulator: `acc = acc + expr` (or `+=`, `*`, `*=`) riding the
 *  loop. REASSOCIATION: the vector accumulator sums pairs and the tail
 *  continues sequentially, so the result may differ in the last ulp from
 *  the pure scalar loop — this shape is only planned under the explicit
 *  `fast_math` opt-in. */
export interface NeonReduction {
	readonly name: string;
	readonly op: "+" | "*";
	readonly operand: NeonLaneExpr;
	/** The accumulator's init expression (loaded + splatted at vector entry). */
	readonly init_node: BaseNode;
}

export interface NeonPlan {
	readonly induction: string;
	/** Leaf/literal bound of the `i < bound` condition. */
	readonly bound_node: BaseNode;
	readonly lanes: readonly NeonLaneStmt[];
	/** Distinct Buffer receivers in first-appearance order (≤ MAX_BUFFERS). */
	readonly buffers: readonly { readonly name: string; readonly node: BaseNode }[];
	/** Element kind — every access in the loop agreed on this descriptor. */
	readonly elem: ElemDesc;
	/** Vector accumulators (≤ MAX_REDUCTIONS; fast_math opt-in only). */
	readonly reductions: readonly NeonReduction[];
}

// Literal shapes — mirrored exactly from build_float_operand's accepted
// forms (anything else would take a different emission path).
const FLOAT_LIT_RE = /^(\+|-)*\d+\.\d+$/;
const INT_LIT_RE = /^(\+|-)*\d+$/;

function is_buffer_type_name(name: string): boolean {
	return name === "Buffer" || name.startsWith("Buffer_");
}

function node_value(e: NirExpr): string | null {
	if (e.kind !== "leaf") return null;
	const n = e.node as ValueNode | undefined;
	return n && typeof n.value === "string" ? n.value : null;
}

function float_type_of_name(name: string, status: BuildStatus): boolean {
	const decl = status.scoped_declarations?.findLast((d) => d.name === name);
	if (decl?.type?.name) return decl.type.name === "float";
	const stamped = status.variable_types?.get(name)?.name;
	return stamped === "float";
}

/** Identifier reads of one NIR expression (recursively). */
function expr_reads(e: NirExpr | null | undefined, out: Set<string>): void {
	if (!e) return;
	switch (e.kind) {
		case "leaf":
			if (e.name) out.add(e.name);
			return;
		case "binary":
			expr_reads(e.left, out);
			expr_reads(e.right, out);
			return;
		case "wrap":
			expr_reads(e.inner, out);
			return;
		case "call":
			for (const a of e.facts.args) expr_reads(a, out);
			for (const s of e.facts.swap_exprs) expr_reads(s, out);
			return;
		case "method_call":
			expr_reads(e.receiver, out);
			for (const a of e.facts.args) expr_reads(a, out);
			for (const s of e.facts.swap_exprs) expr_reads(s, out);
			return;
		case "path":
			expr_reads(e.receiver, out);
			return;
		case "spawn":
			expr_reads(e.call, out);
			return;
		case "flow":
			if (e.scrutinee) expr_reads(e.scrutinee, out);
			for (const arm of e.arms) {
				if (arm.condition) expr_reads(arm.condition, out);
				for (const inner of arm.branch) stmt_reads(inner, out);
			}
			if (e.otherwise) for (const inner of e.otherwise) stmt_reads(inner, out);
			return;
		case "other":
			return;
		default: {
			const _exhaustive: never = e;
			void _exhaustive;
			return;
		}
	}
}

/** Identifier reads of one NIR statement (recursively, bodies included). */
export function stmt_reads(s: NirStmt, out: Set<string>): void {
	switch (s.kind) {
		case "declare":
			if (s.decl.init) expr_reads(s.decl.init, out);
			if (s.decl.swap) expr_reads(s.decl.swap, out);
			return;
		case "assign":
			expr_reads(s.target, out);
			expr_reads(s.rhs, out);
			if (s.swap) expr_reads(s.swap, out);
			return;
		case "eval":
			expr_reads(s.expr, out);
			return;
		case "spawn":
			expr_reads(s.call, out);
			return;
		case "return":
			expr_reads(s.value, out);
			return;
		case "if":
			expr_reads(s.cond, out);
			for (const inner of s.then_branch) stmt_reads(inner, out);
			for (const inner of s.else_branch) stmt_reads(inner, out);
			return;
		case "while":
			expr_reads(s.cond, out);
			for (const inner of s.body) stmt_reads(inner, out);
			if (s.update) stmt_reads(s.update, out);
			return;
		case "for":
			if (s.list) expr_reads(s.list, out);
			for (const inner of s.body) stmt_reads(inner, out);
			if (s.update) stmt_reads(s.update, out);
			return;
		case "switch_match":
			if (s.scrutinee) expr_reads(s.scrutinee, out);
			for (const arm of s.arms) {
				if (arm.condition) expr_reads(arm.condition, out);
				for (const inner of arm.branch) stmt_reads(inner, out);
			}
			if (s.otherwise) for (const inner of s.otherwise) stmt_reads(inner, out);
			return;
		case "async_block":
			for (const inner of s.body) stmt_reads(inner, out);
			return;
		case "nested_func":
			for (const inner of s.body) stmt_reads(inner, out);
			return;
		case "anon_struct":
			for (const f of s.fields) expr_reads(f.expr, out);
			return;
		default:
			return;
	}
}

interface PlanWalk {
	lanes: NeonLaneStmt[];
	buffers: { name: string; node: BaseNode }[];
	buffer_index: Map<string, number>;
	temps: string[];
	/** Names defined anywhere in the loop (temps + induction). */
	defs: Set<string>;
	/** Defs already emitted by earlier lane statements (in order). */
	defed_so_far: Set<string>;
	max_depth: number;
	/** Element descriptor, discovered from the first Buffer access. */
	elem: ElemDesc | null;
	/** Name-derived element class per temp (consistency-checked at the end). */
	temp_classes: Map<string, ElemClass>;
	/** Registered accumulator names — reads outside their own reduction
	 *  reject (the vector form must not observe partial sums). */
	reductions: Set<string>;
}

function discover_load_desc(name: string, walk: PlanWalk): ElemDesc | null {
	const desc = ELEM_DESCS.find((d) => d.load === name);
	if (!desc) return null;
	if (walk.elem && walk.elem !== desc) return null;
	walk.elem = desc;
	return desc;
}

function discover_store_desc(name: string, walk: PlanWalk): ElemDesc | null {
	const desc = ELEM_DESCS.find((d) => d.store === name);
	if (!desc) return null;
	if (walk.elem && walk.elem !== desc) return null;
	walk.elem = desc;
	return desc;
}

function buffer_index_of(walk: PlanWalk, name: string, node: BaseNode): number | null {
	const found = walk.buffer_index.get(name);
	if (found !== undefined) return found;
	if (walk.buffers.length >= MAX_BUFFERS) return null;
	const idx = walk.buffers.length;
	walk.buffers.push({ name, node });
	walk.buffer_index.set(name, idx);
	return idx;
}

// --- Checker-hoisted call-argument temps -----------------------------------

/**
 * The checker rewrites non-trivial call arguments (`b.store_float(i, x + 1.0)`)
 * into references to hoisted `_param_N` (or `_recv_N`) temp declarations
 * attached to the statement node as `node.allocations`; the temp's initializer
 * is the ORIGINAL user expression. In the scalar path the temp's slot is
 * written per iteration; in the vector loop those slots are never written, so
 * a naive "invariant scalar" read would observe stale bytes. The planner
 * therefore converts each hoisted temp into a per-lane temp_def (and rejects
 * any allocation shape it cannot model exactly).
 */

/** True when any node in the subtree carries attached allocations. */
function has_allocations(node: BaseNode | null | undefined): boolean {
	if (!node || typeof node !== "object") return false;
	const allocs = (node as unknown as { allocations?: BaseNode[] }).allocations;
	if (allocs && allocs.length > 0) return true;
	for (const key of Object.keys(node)) {
		if (key === "parent" || key === "scope" || key === "allocations") continue;
		const v = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(v)) {
			for (const item of v) {
				if (item && typeof item === "object" && "node_type" in (item as object)) {
					if (has_allocations(item as BaseNode)) return true;
				}
			}
		} else if (v && typeof v === "object" && "node_type" in (v as object)) {
			if (has_allocations(v as BaseNode)) return true;
		}
	}
	return false;
}

/** Shallow AST → NIR expression mirror (only the lane-relevant shapes). */
function ast_to_nir_shallow(n: BaseNode): NirExpr | null {
	switch (n.node_type) {
		case "value": {
			const v = (n as ValueNode).value;
			return { kind: "leaf", node: n, name: is_identifier_like(v) ? v : null };
		}
		case "op": {
			const op = n as OperationNode;
			if (op.left_value === undefined || op.left_value === null) return null; // unary
			const left = ast_to_nir_shallow(op.left_value);
			const right = op.right_value ? ast_to_nir_shallow(op.right_value) : null;
			if (!left || !right) return null;
			return { kind: "binary", node: n, left, right };
		}
		case "grouped": {
			const inner = ast_to_nir_shallow((n as GroupedNode).value);
			return inner ? { kind: "wrap", node: n, inner } : null;
		}
		case "access": {
			const acc = n as AccessNode;
			if (!acc.access || acc.access.node_type !== "access_func") return null; // field path
			const af = acc.access as AccessFunctionCallNode;
			const receiver = ast_to_nir_shallow(acc.target);
			if (!receiver) return null;
			const args: NirExpr[] = [];
			for (const p of af.params ?? []) {
				const a = ast_to_nir_shallow(p);
				if (!a) return null;
				args.push(a);
			}
			return {
				kind: "method_call",
				node: n,
				receiver,
				name: af.name,
				facts: {
					args,
					ref_arg_indices: [...((af.ref_param_indices as number[]) ?? [])],
					swap_exprs: [],
				},
			};
		}
		default:
			return null;
	}
}

interface AllocTemp {
	readonly name: string;
	readonly value: BaseNode;
}

/**
 * Hoisted temps attached to a lane statement (eval stores only in practice).
 * Returns null when an allocation cannot be modeled as a simple lane temp.
 */
function alloc_temps_of(s: NirStmt, walk: PlanWalk): AllocTemp[] | null {
	if (s.kind !== "eval") return [];
	const allocs = (s.node as unknown as { allocations?: BaseNode[] }).allocations;
	if (!allocs || allocs.length === 0) return [];
	const out: AllocTemp[] = [];
	for (const a of allocs) {
		const d = a as DeclarationNode;
		if (!d.name || !d.value) return null;
		if (has_allocations(d.value)) return null; // nested hoists: too complex
		const cls = class_of_type_name(d.type?.name);
		if (!cls) return null;
		if (walk.elem && cls !== class_of_elem(walk.elem)) return null;
		walk.temp_classes.set(d.name, cls);
		out.push({ name: d.name, value: d.value });
	}
	return out;
}

function lane_expr(
	e: NirExpr,
	walk: PlanWalk,
	induction: string,
	status: BuildStatus,
	depth: number,
): NeonLaneExpr | null {
	if (depth > walk.max_depth) walk.max_depth = depth;
	if (depth > MAX_OP_DEPTH) return null;
	switch (e.kind) {
		case "method_call": {
			// `buf.load_T(i)` — the only call shape allowed; the method name
			// picks (and pins) the element descriptor.
			if (!discover_load_desc(e.name, walk)) return null;
			if (e.facts.ref_arg_indices.length > 0 || e.facts.swap_exprs.length > 0) return null;
			if (e.receiver.kind !== "leaf" || !e.receiver.name) return null;
			if (e.facts.args.length !== 1) return null;
			const idx = e.facts.args[0];
			if (idx.kind !== "leaf" || idx.name !== induction) return null;
			const tname = type_from_value_node(e.receiver.node)?.name ?? "";
			if (!is_buffer_type_name(tname)) return null;
			const bi = buffer_index_of(walk, e.receiver.name, e.receiver.node);
			if (bi === null) return null;
			return { k: "load", buffer: e.receiver.name, node: e.receiver.node };
		}
		case "leaf": {
			if (!e.name) {
				// Literal — float literals for the float kind, int literals
				// otherwise (the emitter materializes per kind).
				const v = node_value(e);
				if (v === null) return null;
				if (walk.elem) {
					if (walk.elem.float ? !FLOAT_LIT_RE.test(v) : !INT_LIT_RE.test(v)) return null;
				} else if (!(FLOAT_LIT_RE.test(v) || INT_LIT_RE.test(v))) {
					return null;
				}
				return { k: "lit", node: e.node };
			}
			if (e.name === induction) return null; // induction in value position
			if (walk.reductions.has(e.name)) return null; // accumulator outside its own reduction
			if (walk.defs.has(e.name)) {
				// Temp: must be defined by an EARLIER statement of this
				// iteration — a same-statement or later-first def is a
				// loop-carried dependency.
				if (!walk.defed_so_far.has(e.name)) return null;
				return { k: "temp", name: e.name };
			}
			// Loop-invariant scalar — element class must match the plan's
			// descriptor (float lanes take float scalars, int lanes take
			// same-width ints).
			const tname = type_from_value_node(e.node)?.name;
			const cls = tname
				? class_of_type_name(tname)
				: float_type_of_name(e.name, status)
					? "float"
					: class_of_type_name(status.variable_types?.get(e.name)?.name);
			if (!cls) return null;
			if (walk.elem && cls !== class_of_elem(walk.elem)) return null;
			return { k: "scalar", name: e.name, node: e.node };
		}
		case "binary": {
			// Unary minus lowers to a binary with no left operand — reject.
			const op_node = e.node as OperationNode;
			if (op_node.left_value === undefined || op_node.left_value === null) return null;
			const op = op_node.op;
			if (walk.elem && !op_allowed(op, walk.elem)) return null;
			if (!["+", "-", "*", "/", "&", "|", "^"].includes(op)) return null;
			const left = lane_expr(e.left, walk, induction, status, depth + 1);
			if (!left) return null;
			const right = lane_expr(e.right, walk, induction, status, depth + 1);
			if (!right) return null;
			if (walk.elem && !op_allowed(op, walk.elem)) return null;
			return { k: "op", op: op as "+" | "-" | "*" | "/" | "&" | "|" | "^", left, right };
		}
		case "wrap": {
			// Grouped parens are a pure pass-through; anything else (casts)
			// stays on the scalar path.
			if (e.node.node_type !== "grouped" || !e.inner) return null;
			return lane_expr(e.inner, walk, induction, status, depth);
		}
		default:
			return null;
	}
}

/** Does this statement define `name` (for the init scan)? */
function defs_name(s: NirStmt, name: string): boolean {
	if (s.kind === "declare") return s.decl.name === name;
	if (s.kind === "assign") return s.target.kind === "leaf" && s.target.name === name;
	return false;
}

function is_zero_leaf(e: NirExpr | null): boolean {
	if (!e || e.kind !== "leaf" || e.name !== null) return false;
	return node_value(e)?.replace(/^\+/, "") === "0";
}

/** Literal-zero check on an AST value node (init-scan result). */
function is_zero_ast_node(node: BaseNode | null): boolean {
	const v = (node as ValueNode | undefined)?.value;
	return typeof v === "string" && v.replace(/^\+/, "") === "0";
}

function is_one_leaf(e: NirExpr | null): boolean {
	if (!e || e.kind !== "leaf" || e.name !== null) return false;
	return node_value(e)?.replace(/^\+/, "") === "1";
}

/** `i += 1` or `i = i + 1` — the one sanctioned induction increment. */
function is_increment(s: NirStmt, induction: string): boolean {
	if (s.kind !== "assign") return false;
	if (s.target.kind !== "leaf" || s.target.name !== induction) return false;
	// The parser stamps the RAW token on AssignmentNode.operator: "+=" for
	// compound assignment, undefined for a plain `=`.
	if (s.operator === "+" || s.operator === "+=") return is_one_leaf(s.rhs);
	if (s.operator !== null) return false;
	// `i = i + 1`
	if (s.rhs.kind !== "binary") return false;
	const op_node = s.rhs.node as OperationNode;
	if (op_node.op !== "+") return false;
	if (s.rhs.left.kind !== "leaf" || s.rhs.left.name !== induction) return false;
	return is_one_leaf(s.rhs.right);
}

interface InitScan {
	ok: boolean;
	/** The init value's AST node (declare initializer / assign RHS). */
	init_node: BaseNode | null;
}

/**
 * Backward scan from `index`: the nearest statement defining `name` must be
 * a plain declare or assign (its value is the stable loop-entry value);
 * barriers and constructs that may redefine arbitrary names abort. Callers
 * add shape requirements (the induction additionally needs a literal 0).
 */
function scan_init(list: readonly NirStmt[], index: number, name: string): InitScan {
	for (let k = index - 1; k >= 0; k--) {
		const s = list[k];
		if (defs_name(s, name)) {
			if (s.kind === "declare" && !s.decl.swap) {
				return { ok: s.decl.init !== null, init_node: s.decl.init?.node ?? null };
			}
			if (
				s.kind === "assign" &&
				s.operator === null &&
				!s.swap &&
				s.target.kind === "leaf" &&
				s.target.name === name
			) {
				return { ok: true, init_node: s.rhs.node };
			}
			return { ok: false, init_node: null };
		}
		// Statements that may redefine arbitrary names stop the scan.
		if (s.kind !== "declare" && s.kind !== "assign" && s.kind !== "eval" && s.kind !== "return") {
			return { ok: false, init_node: null };
		}
		if (s.kind === "eval") {
			// A call may define the name only through ref args / swapees /
			// receivers.
			const e = s.expr;
			const roots: NirExpr[] = [];
			if (e.kind === "call" || e.kind === "method_call") {
				roots.push(...e.facts.swap_exprs);
				if (e.facts.ref_arg_indices.length > 0) roots.push(...e.facts.args);
				if (e.kind === "method_call") roots.push(e.receiver);
			} else {
				continue;
			}
			for (const r of roots) {
				if (r.kind === "leaf" && r.name === name) return { ok: false, init_node: null };
			}
		}
	}
	return { ok: false, init_node: null };
}

/**
 * Reduction candidacy for an `assign` lane statement: `acc = acc ±operand`,
 * `acc = operand ±acc`, or the compound `acc += operand` / `acc *= operand`
 * with op `+` or `*`. Returns the split (op, operand expr) or null. Only
 * `+`/`*` — the two operations whose reassociated vector accumulation is
 * well-defined (and only under the fast_math opt-in).
 */
function reduction_candidate(s: NirStmt): { name: string; op: "+" | "*"; operand: NirExpr } | null {
	if (s.kind !== "assign") return null;
	if (s.target.kind !== "leaf" || !s.target.name) return null;
	if (s.swap) return null;
	const name = s.target.name;
	if (s.operator === "+=" || s.operator === "*=") {
		return { name, op: s.operator === "+=" ? "+" : "*", operand: s.rhs };
	}
	if (s.operator !== null) return null;
	if (s.rhs.kind !== "binary") return null;
	const op_node = s.rhs.node as OperationNode;
	if (op_node.op !== "+" && op_node.op !== "*") return null;
	const left_is_acc = s.rhs.left.kind === "leaf" && s.rhs.left.name === name;
	const right_is_acc = s.rhs.right.kind === "leaf" && s.rhs.right.name === name;
	if (left_is_acc === right_is_acc) return null; // neither (or both) sides
	return {
		name,
		op: op_node.op,
		operand: left_is_acc ? s.rhs.right : s.rhs.left,
	};
}

/**
 * Bound extraction shared by both loop forms: a leaf variable or integer
 * literal that is not the induction; literal bounds below MIN_TRIP stay
 * scalar.
 */
function extract_bound(
	bound: NirExpr,
	induction: string,
): { node: BaseNode; name: string | null } | null {
	if (bound.kind !== "leaf") return null;
	if (bound.name) {
		if (bound.name === induction) return null;
		return { node: bound.node, name: bound.name };
	}
	const v = node_value(bound);
	if (v === null || !INT_LIT_RE.test(v)) return null;
	try {
		if (BigInt(v) < BigInt(MIN_TRIP)) return null;
	} catch {
		return null;
	}
	return { node: bound.node, name: null };
}

/**
 * Shared plan tail: def pre-pass over `lanes_raw`, lane walk, invariance and
 * escape checks. `bound_name` (when the bound is a leaf) must come out of
 * the pre-pass loop-invariant; `elem` must have been pinned by some access.
 */
function plan_common(
	lanes_raw: readonly NirStmt[],
	bound_node: BaseNode,
	bound_name: string | null,
	induction: string,
	index: number,
	list: readonly NirStmt[],
	status: BuildStatus,
	allow_reductions: boolean,
): NeonPlan | null {
	// Reduction candidates (fast_math only): `acc = acc + e` / `acc += e` /
	// `acc = e * acc` shapes whose accumulator is a float LOCAL. Registered
	// before the general def rules — the accumulator's self-read is exactly
	// the carried dependency the vector-accumulate form exists for.
	const reduction_candidates = new Map<
		string,
		{ op: "+" | "*"; operand: NirExpr; cls: ElemClass | null }
	>();
	// Def pre-pass: every lane statement shape + def name. Hoisted call-arg
	// temps attached to an eval store count as defs (they become lane temps).
	const defs = new Set<string>([induction]);
	for (const s of lanes_raw) {
		if (s.kind === "declare") {
			if (!s.decl.name || defs.has(s.decl.name)) return null;
			if (has_allocations(s.node)) return null;
			defs.add(s.decl.name);
			continue;
		}
		if (s.kind === "assign") {
			if (s.target.kind !== "leaf" || !s.target.name) return null;
			const cand = reduction_candidate(s);
			if (cand) {
				// Class-gated soundness: float accumulators REASSOCIATE the
				// sum (fast_math opt-in only); integer `+` is wrap-exact
				// under any association (no opt-in); integer `*` would need
				// a multi-step horizontal combine — not planned.
				const cls =
					class_of_type_name(type_from_value_node(s.target.node)?.name) ??
					(float_type_of_name(cand.name, status)
						? "float"
						: class_of_type_name(status.variable_types?.get(cand.name)?.name));
				const gate_ok =
					cls === "float" ? allow_reductions : (cls === "e8" || cls === "e4") && cand.op === "+";
				if (cls && gate_ok) {
					if (reduction_candidates.has(cand.name)) return null; // one def only
					if (status.function_param_regs?.has(cand.name)) return null; // local only
					if (defs.has(cand.name)) return null;
					defs.add(cand.name);
					reduction_candidates.set(cand.name, { op: cand.op, operand: cand.operand, cls });
					continue;
				}
			}
			if (s.operator !== null || s.swap) return null;
			if (has_allocations(s.node)) return null;
			if (defs.has(s.target.name)) return null;
			defs.add(s.target.name);
			continue;
		}
		if (s.kind === "eval") {
			const e = s.expr;
			if (e.kind !== "method_call") return null;
			const probe: PlanWalk = {
				lanes: [],
				buffers: [],
				buffer_index: new Map(),
				temps: [],
				defs,
				defed_so_far: new Set(),
				max_depth: 0,
				elem: null,
				temp_classes: new Map(),
				reductions: new Set(),
			};
			const temps = alloc_temps_of(s, probe);
			if (!temps) return null;
			for (const t of temps) {
				if (defs.has(t.name)) return null;
				defs.add(t.name);
			}
			continue;
		}
		return null; // any other statement kind: no vectorization
	}
	if (bound_name !== null && defs.has(bound_name)) return null;
	// Accumulators must be stable from their nearest def to loop entry; keep
	// the init expression (splat at vector entry).
	const reduction_inits = new Map<string, BaseNode>();
	for (const name of reduction_candidates.keys()) {
		const scan = scan_init(list, index, name);
		if (!scan.ok || !scan.init_node) return null;
		reduction_inits.set(name, scan.init_node);
	}

	const walk: PlanWalk = {
		lanes: [],
		buffers: [],
		buffer_index: new Map(),
		temps: [],
		defs,
		defed_so_far: new Set(),
		max_depth: 0,
		elem: null,
		temp_classes: new Map(),
		reductions: new Set(reduction_candidates.keys()),
	};
	const reductions: NeonReduction[] = [];
	for (const s of lanes_raw) {
		if (s.kind === "declare") {
			const cls = class_of_type_name(s.decl.type?.name);
			if (!cls) return null;
			if (walk.elem && cls !== class_of_elem(walk.elem)) return null;
			if (s.decl.swap) return null;
			const value = s.decl.init ? lane_expr(s.decl.init, walk, induction, status, 0) : null;
			if (!value) return null;
			walk.temp_classes.set(s.decl.name, cls);
			walk.defed_so_far.add(s.decl.name);
			walk.temps.push(s.decl.name);
			walk.lanes.push({ kind: "temp_def", name: s.decl.name, value });
			continue;
		}
		if (s.kind === "assign") {
			const name = (s.target as { kind: "leaf"; name: string }).name;
			const cand = reduction_candidates.get(name);
			if (cand) {
				// Vector-accumulate the operand; the accumulator never enters
				// lane_expr (its self-read is the carried dependency).
				const operand = lane_expr(cand.operand, walk, induction, status, 0);
				if (!operand) return null;
				walk.temp_classes.set(name, cand.cls ?? "float");
				walk.defed_so_far.add(name);
				reductions.push({
					name,
					op: cand.op,
					operand,
					init_node: reduction_inits.get(name)!,
				});
				walk.lanes.push({ kind: "reduction", name, op: cand.op, operand });
				continue;
			}
			const tname = type_from_value_node(s.target.node)?.name;
			const cls = tname
				? class_of_type_name(tname)
				: float_type_of_name(name, status)
					? "float"
					: class_of_type_name(status.variable_types?.get(name)?.name);
			if (!cls) return null;
			if (walk.elem && cls !== class_of_elem(walk.elem)) return null;
			const value = lane_expr(s.rhs, walk, induction, status, 0);
			if (!value) return null;
			walk.temp_classes.set(name, cls);
			walk.defed_so_far.add(name);
			walk.temps.push(name);
			walk.lanes.push({ kind: "temp_def", name, value });
			continue;
		}
		// eval: store_T only. Hoisted arg temps become per-lane temp_defs
		// first (the NIR value arg references the temp name).
		const e = (s as { kind: "eval"; expr: NirExpr }).expr;
		if (e.kind !== "method_call" || !discover_store_desc(e.name, walk)) return null;
		if (e.facts.ref_arg_indices.length > 0 || e.facts.swap_exprs.length > 0) return null;
		if (e.receiver.kind !== "leaf" || !e.receiver.name) return null;
		if (e.facts.args.length !== 2) return null;
		const idx = e.facts.args[0];
		if (idx.kind !== "leaf" || idx.name !== induction) return null;
		const tname = type_from_value_node(e.receiver.node)?.name ?? "";
		if (!is_buffer_type_name(tname)) return null;
		if (buffer_index_of(walk, e.receiver.name, e.receiver.node) === null) return null;
		const temps = alloc_temps_of(s, walk);
		if (!temps) return null;
		for (const t of temps) {
			const nir = ast_to_nir_shallow(t.value);
			if (!nir) return null;
			const tvalue = lane_expr(nir, walk, induction, status, 0);
			if (!tvalue) return null;
			walk.defed_so_far.add(t.name);
			walk.temps.push(t.name);
			walk.lanes.push({ kind: "temp_def", name: t.name, value: tvalue });
		}
		const value = lane_expr(e.facts.args[1], walk, induction, status, 0);
		if (!value) return null;
		walk.lanes.push({
			kind: "store",
			buffer: e.receiver.name,
			buffer_node: e.receiver.node,
			value,
		});
	}
	if (walk.temps.length > MAX_TEMPS) return null;
	if (!walk.lanes.some((l) => l.kind === "store") && reductions.length === 0) return null;
	if (!walk.elem) return null; // no Buffer access — nothing to vectorize
	// Every temp's element class must agree with the discovered descriptor
	// (accumulators register as float, so this also pins elem to f64).
	const want = class_of_elem(walk.elem);
	for (const cls of walk.temp_classes.values()) {
		if (cls !== want) return null;
	}
	if (reductions.length > MAX_REDUCTIONS) return null;

	// Per-lane temps must not be read after the loop in the enclosing list —
	// accumulators are the loop's OUTPUT and are exempt.
	if (walk.temps.length > 0) {
		const after = new Set<string>();
		for (let k = index + 1; k < list.length; k++) stmt_reads(list[k], after);
		for (const t of walk.temps) {
			if (after.has(t)) return null;
		}
	}

	return {
		induction,
		bound_node,
		lanes: walk.lanes,
		buffers: walk.buffers,
		elem: walk.elem,
		reductions,
	};
}

/**
 * Attempt to plan a NEON vector loop for `nstmt` (the lowered `while` at
 * `index` of `list`). Returns null unless EVERY soundness condition holds —
 * the caller must then emit the scalar loop unchanged as the tail.
 */
export function plan_vector_loop(
	nstmt: NirStmt & { kind: "while" },
	index: number,
	list: readonly NirStmt[],
	status: BuildStatus,
): NeonPlan | null {
	const cond = nstmt.cond;
	if (cond.kind !== "binary") return null;
	const cond_op = cond.node as OperationNode;
	if (cond_op.op !== "<") return null;
	if (cond.left.kind !== "leaf" || !cond.left.name) return null;
	const induction = cond.left.name;
	const bound = extract_bound(cond.right, induction);
	if (!bound) return null;

	// The increment lives in the update slot or as the last body statement.
	let lanes_raw: readonly NirStmt[];
	if (nstmt.update) {
		if (!is_increment(nstmt.update, induction)) return null;
		lanes_raw = nstmt.body;
	} else {
		if (nstmt.body.length === 0) return null;
		const last = nstmt.body[nstmt.body.length - 1];
		if (!is_increment(last, induction)) return null;
		lanes_raw = nstmt.body.slice(0, -1);
	}

	// Init: scanning backwards, the FIRST statement defining the induction
	// must establish literal 0; barriers and anything that might redefine it
	// abort.
	const init = scan_init(list, index, induction);
	if (!init.ok || !init.init_node || !is_zero_ast_node(init.init_node)) return null;

	return plan_common(
		lanes_raw,
		bound.node,
		bound.name,
		induction,
		index,
		list,
		status,
		status.fast_math === true,
	);
}

/**
 * Range-form plans: `for i of 0 .. n` — the builder itself initializes the
 * induction to the range start (which must be absent or literal 0) and
 * steps it by one, so no init scan is needed; everything else is the
 * shared elementwise pattern.
 */
export function plan_vector_for(
	nstmt: NirStmt & { kind: "for" },
	index: number,
	list: readonly NirStmt[],
	status: BuildStatus,
): NeonPlan | null {
	const l = nstmt.list;
	if (!l || l.kind !== "binary") return null;
	if (l.node.node_type !== "range") return null; // array/enumerable fors: no
	const range = l.node as RangeNode;
	if (range.left_value !== undefined && range.left_value !== null && !is_zero_leaf(l.left)) {
		return null;
	}
	if (!range.right_value) return null;
	const bound = extract_bound(l.right, nstmt.item_name);
	if (!bound) return null;
	return plan_common(
		nstmt.body,
		bound.node,
		bound.name,
		nstmt.item_name,
		index,
		list,
		status,
		status.fast_math === true,
	);
}
