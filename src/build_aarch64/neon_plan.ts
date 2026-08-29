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
import type ValueNode from "../nodes/ValueNode.ts";

/**
 * NEON loop-vectorization planning over the NIR (ASM_PLAN phase 4) — the
 * detection half of the vectorizer. `plan_vector_loop` pattern-matches the
 * canonical count-up elementwise float loop and returns an emission plan,
 * or null when ANY soundness condition fails (the caller then emits the
 * plain scalar loop, byte-identical to the pre-vectorizer output).
 *
 * Pattern (all parts verified structurally before a plan is returned):
 *
 *   var i = 0                    ← immediately-established 0 init
 *   while i < N; i += 1 {        ← `i += 1` in the update slot OR as the
 *     ...                          last body statement
 *     buf.store_float(i, expr)   ← ≥1 store; loads at index i only
 *   }
 *
 * Soundness model (why this is legal):
 *
 * - ALIASING IS A NON-ISSUE BY CONSTRUCTION: every Buffer access in the
 *   loop (load or store, any buffer) uses EXACTLY the induction index, so
 *   a vector iteration touches the same element set {i, i+1} that the two
 *   scalar iterations it replaces would. Lane k reads element i+k before
 *   lane k writes element i+k; no lane reads an element another lane
 *   writes, whatever buffers alias. This is why shifted indices
 *   (`load_float(i + 1)`) are rejected outright.
 * - TRIP SEMANTICS: the vector loop runs over i ∈ {0, 2, 4, …} while
 *   i < (N & ~1); a base-0 even-stepping induction keeps both lane indices
 *   < N. The ORIGINAL scalar loop is emitted unchanged afterwards as the
 *   tail (the induction is synced to the vector loop's exit counter first),
 *   covering the N % 2 remainder — including the N < 2 (or negative-N)
 *   cases where the vector loop exits immediately and `bic` on a negative
 *   bound only rounds the limit down.
 * - NO REASSOCIATION: float reductions (`a = a + … * buf.load_float(i)`)
 *   would change summation order and are rejected — a name that is defined
 *   anywhere in the loop may only be read AFTER its defining statement in
 *   the same iteration (straight-line single-assignment temps).
 * - TEMPS NEVER ESCAPE: per-lane temps live in v-registers inside the
 *   vector loop; the scalar tail re-declares them into their own slots. A
 *   temp read anywhere AFTER the loop in the enclosing statement list would
 *   observe the last tail iteration's value when the tail runs but stale
 *   bytes when it doesn't (N % 2 == 0) — such reads reject the plan.
 * - NO OTHER EFFECTS: the body may contain only float temp declares /
 *   assigns and store_float evals — no calls, no control flow, no ref args,
 *   no swaps, no raw blocks — so there is nothing the vector loop could
 *   reorder, skip, or duplicate.
 * - The bound N is a leaf variable or integer literal and is not defined
 *   anywhere in the loop, so hoisting `lim = N & ~1` into the preheader is
 *   exact.
 */

/** Max distinct Buffers per plan — the preheader pins each data pointer in
 *  a dedicated scratch register (x11..x13). */
const MAX_BUFFERS = 3;
/** Max per-lane temps (v4..v7). */
const MAX_TEMPS = 4;
/** Max binary-op nesting depth in lane expressions (spill regs v14→v11). */
const MAX_OP_DEPTH = 4;

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
			readonly op: "+" | "-" | "*" | "/";
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
	  };

export interface NeonPlan {
	readonly induction: string;
	/** Leaf/literal bound of the `i < bound` condition. */
	readonly bound_node: BaseNode;
	readonly lanes: readonly NeonLaneStmt[];
	/** Distinct Buffer receivers in first-appearance order (≤ MAX_BUFFERS). */
	readonly buffers: readonly { readonly name: string; readonly node: BaseNode }[];
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
 * Returns null when an allocation cannot be modeled as a simple float temp.
 */
function alloc_temps_of(s: NirStmt): AllocTemp[] | null {
	if (s.kind !== "eval") return [];
	const allocs = (s.node as unknown as { allocations?: BaseNode[] }).allocations;
	if (!allocs || allocs.length === 0) return [];
	const out: AllocTemp[] = [];
	for (const a of allocs) {
		const d = a as DeclarationNode;
		if (!d.name || !d.value) return null;
		if (has_allocations(d.value)) return null; // nested hoists: too complex
		if (d.type?.name !== "float") return null;
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
			// `buf.load_float(i)` — the only call shape allowed.
			if (e.name !== "load_float") return null;
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
				// Literal (float or int — the emitter's float-operand path
				// handles both).
				const v = node_value(e);
				if (v === null || !(FLOAT_LIT_RE.test(v) || INT_LIT_RE.test(v))) return null;
				return { k: "lit", node: e.node };
			}
			if (e.name === induction) return null; // induction in value position
			if (walk.defs.has(e.name)) {
				// Temp: must be defined by an EARLIER statement of this
				// iteration — a same-statement or later-first def is a
				// loop-carried dependency.
				if (!walk.defed_so_far.has(e.name)) return null;
				return { k: "temp", name: e.name };
			}
			// Loop-invariant float scalar.
			const tname = type_from_value_node(e.node)?.name;
			const is_float = tname ? tname === "float" : float_type_of_name(e.name, status);
			if (!is_float) return null;
			return { k: "scalar", name: e.name, node: e.node };
		}
		case "binary": {
			// Unary minus lowers to a binary with no left operand — reject.
			const op_node = e.node as OperationNode;
			if (op_node.left_value === undefined || op_node.left_value === null) return null;
			const op = op_node.op;
			if (op !== "+" && op !== "-" && op !== "*" && op !== "/") return null;
			const left = lane_expr(e.left, walk, induction, status, depth + 1);
			if (!left) return null;
			const right = lane_expr(e.right, walk, induction, status, depth + 1);
			if (!right) return null;
			return { k: "op", op, left, right };
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
	// Bound: leaf variable or integer literal.
	const bound = cond.right;
	let bound_node: BaseNode;
	if (bound.kind === "leaf" && bound.name) {
		if (bound.name === induction) return null;
		bound_node = bound.node;
	} else if (bound.kind === "leaf" && !bound.name && INT_LIT_RE.test(node_value(bound) ?? "")) {
		bound_node = bound.node;
	} else {
		return null;
	}

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
	// must establish 0; barriers and anything that might redefine it abort.
	let init_ok = false;
	for (let k = index - 1; k >= 0; k--) {
		const s = list[k];
		if (defs_name(s, induction)) {
			if (s.kind === "declare" && !s.decl.swap && is_zero_leaf(s.decl.init)) init_ok = true;
			if (
				s.kind === "assign" &&
				s.operator === null &&
				!s.swap &&
				s.target.kind === "leaf" &&
				s.target.name === induction &&
				is_zero_leaf(s.rhs)
			) {
				init_ok = true;
			}
			break;
		}
		// Statements that may redefine arbitrary names stop the scan.
		if (s.kind !== "declare" && s.kind !== "assign" && s.kind !== "eval" && s.kind !== "return") {
			return null;
		}
		if (s.kind === "eval") {
			// A call may define the induction only through ref args /
			// swapees / receivers.
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
				if (r.kind === "leaf" && r.name === induction) return null;
			}
		}
	}
	if (!init_ok) return null;

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
			if (s.operator !== null || s.swap) return null;
			if (has_allocations(s.node)) return null;
			if (defs.has(s.target.name)) return null;
			defs.add(s.target.name);
			continue;
		}
		if (s.kind === "eval") {
			const e = s.expr;
			if (e.kind !== "method_call") return null;
			const temps = alloc_temps_of(s);
			if (!temps) return null;
			for (const t of temps) {
				if (defs.has(t.name)) return null;
				defs.add(t.name);
			}
			continue;
		}
		return null; // any other statement kind: no vectorization
	}
	// The bound must be loop-invariant.
	if (bound.kind === "leaf" && bound.name && defs.has(bound.name) && bound.name !== induction) {
		return null;
	}

	const walk: PlanWalk = {
		lanes: [],
		buffers: [],
		buffer_index: new Map(),
		temps: [],
		defs,
		defed_so_far: new Set(),
		max_depth: 0,
	};
	for (const s of lanes_raw) {
		if (s.kind === "declare") {
			if (s.decl.type?.name !== "float") return null;
			if (s.decl.swap) return null;
			const value = s.decl.init ? lane_expr(s.decl.init, walk, induction, status, 0) : null;
			if (!value) return null;
			walk.defed_so_far.add(s.decl.name);
			walk.temps.push(s.decl.name);
			walk.lanes.push({ kind: "temp_def", name: s.decl.name, value });
			continue;
		}
		if (s.kind === "assign") {
			const name = (s.target as { kind: "leaf"; name: string }).name;
			const tname = type_from_value_node(s.target.node)?.name;
			if (tname ? tname !== "float" : !float_type_of_name(name, status)) return null;
			const value = lane_expr(s.rhs, walk, induction, status, 0);
			if (!value) return null;
			walk.defed_so_far.add(name);
			walk.temps.push(name);
			walk.lanes.push({ kind: "temp_def", name, value });
			continue;
		}
		// eval: store_float only. Hoisted arg temps become per-lane temp_defs
		// first (the NIR value arg references the temp name).
		const e = (s as { kind: "eval"; expr: NirExpr }).expr;
		if (e.kind !== "method_call" || e.name !== "store_float") return null;
		if (e.facts.ref_arg_indices.length > 0 || e.facts.swap_exprs.length > 0) return null;
		if (e.receiver.kind !== "leaf" || !e.receiver.name) return null;
		if (e.facts.args.length !== 2) return null;
		const idx = e.facts.args[0];
		if (idx.kind !== "leaf" || idx.name !== induction) return null;
		const tname = type_from_value_node(e.receiver.node)?.name ?? "";
		if (!is_buffer_type_name(tname)) return null;
		if (buffer_index_of(walk, e.receiver.name, e.receiver.node) === null) return null;
		const temps = alloc_temps_of(s);
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
	if (!walk.lanes.some((l) => l.kind === "store")) return null;

	// Per-lane temps must not be read after the loop in the enclosing list.
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
	};
}
