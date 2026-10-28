import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type AssignmentNode from "../../nodes/AssignmentNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import { child_nodes } from "../../nodes/child_nodes.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";

/**
 * Checker-level LAST-USE analysis for mv-on-last-use assignment.
 *
 * Two shapes, one liveness test:
 *
 * 1. STRING assignment (STRING_PLAN tranche 4's gate receipt). `s = t` where
 *    `t` is a plain owned `string` local strdups t's bytes only because both
 *    sides would otherwise own them. When `t` is never READ again after the
 *    assignment, the copy is dead weight: transfer the pair and mark `t`
 *    moved instead. Stamped (`AssignmentNode.last_use_move`) and consumed by
 *    both backends.
 *
 * 2. STRUCT copy (PERF_PLAN item 3). `a = b.copy()` / `var a = b.copy()`
 *    where the checker resolved the SYNTHESIZED deep-copy method (`copy` of
 *    a copyable value struct) deep-copies every field — a strdup per string
 *    field, a fresh container per `List` field. When `b` is genuinely dead
 *    after the site, the deep copy is dead weight: the RHS is REWRITTEN to
 *    `mv b`, and the explicit-transfer lowering both backends already
 *    implement (donor cleanup suppressed, displaced-value reclaim kept)
 *    does the rest. A user-written `copy` method never carries the
 *    synthesized marker (`FunctionNode.is_synthesized_copy`), so arbitrary
 *    `copy` methods are never rewritten.
 *
 * This module MEASURES how often those shapes occur in a real program — the
 * tranche's stated gate ("a checker-level last-use receipt on a real pattern
 * first; do not start without it") — and is structured so the builders can
 * later consume the same verdict without re-deriving it.
 *
 * Soundness posture (conservative: it may MISS a last-use, never invent
 * one):
 *   - any read of the source textually after the site counts against it —
 *     including reads in sibling branches (one may execute after the
 *     other; the DFS order only ever RELAXES the then/else case in the
 *     sound direction: a site visited after a sibling-branch read is
 *     refused, never the reverse),
 *   - any read of the source ANYWHERE inside a loop that encloses the site
 *     counts (reads before the site too: the back edge re-executes them),
 *   - any read inside a spawn / async subtree is execution-order opaque
 *     and counts,
 *   - the source must be a `var` local (params and consts are not movable
 *     here), and the site must be a whole-variable assignment/declare with
 *     the source (or its `.copy()` call) as the ENTIRE right side — no
 *     swap, no compound operator, no self-assignment (`p = p.copy()` reads
 *     itself).
 */

let move_enabled = true;

/** Kill-switch for the mv-on-last-use emission (default ON). OFF = the
 *  stamping pass clears its marks and the backends keep the strdup'd copy —
 *  output byte-identical to the pre-tranche compiler. */
export function set_move_on_last_use_enabled(enabled: boolean): void {
	move_enabled = enabled;
}

export function move_on_last_use_enabled(): boolean {
	return move_enabled;
}

/** Non-enumerable field name holding the ORIGINAL `.copy()` RHS of a
 *  rewritten declare/assign — the kill-switch (move_enabled OFF) restores it
 *  so a rebuilt AST emits the deep copy again. Non-enumerable like
 *  set_resolved_function: a node-valued field must stay invisible to the
 *  reflective walkers (child_nodes, Object.keys scans) or the detached
 *  original would be walked twice. */
const LAST_USE_ORIGINAL = "last_use_move_original";

function set_last_use_original(node: BaseNode, original: BaseNode): void {
	Object.defineProperty(node, LAST_USE_ORIGINAL, {
		value: original,
		enumerable: false,
		writable: true,
		configurable: true,
	});
}

function get_last_use_original(node: BaseNode): BaseNode | undefined {
	return (node as unknown as Record<string, unknown>)[LAST_USE_ORIGINAL] as BaseNode | undefined;
}

/** Rewrite a classified struct-copy site into the explicit transfer: the
 *  `.copy()` RHS is replaced by `mv <source>` (a bare moved ValueNode), the
 *  exact AST shape a hand-written transfer produces, so both backends'
 *  tested mv lowerings (donor cleanup suppressed, displaced-value reclaim
 *  kept, moved-flag guards for conditional paths) do the work. Idempotent:
 *  a re-stamp of the rewritten tree finds no `.copy()` call and refuses. */
function rewrite_struct_copy_as_move(node: DeclarationNode | AssignmentNode): boolean {
	const is_assign = node.node_type === "assign";
	const rhs = is_assign ? (node as AssignmentNode).right_value : (node as DeclarationNode).value;
	if (!rhs) return false;
	const receiver = struct_copy_receiver(rhs);
	if (!receiver) return false; // already rewritten (or a stale hit) — nothing to do
	const moved = new ValueNode(receiver.start, receiver.value, receiver.type);
	moved.is_moved = true;
	set_last_use_original(node, rhs);
	if (is_assign) {
		(node as AssignmentNode).right_value = moved;
	} else {
		(node as DeclarationNode).value = moved;
	}
	return true;
}

/**
 * Stamps `last_use_move` on candidate declare/assignment nodes across the
 * tree (string sources), and REWRITES struct `.copy()` sites whose source is
 * proven dead after into explicit `mv` transfers. Run once per build, after
 * checking (types are stamped). With the kill-switch OFF, existing stamps are
 * CLEARED and rewrites are RESTORED so repeated builds of a shared AST stay
 * deterministic. Returns the number of stamps.
 */
export function stamp_last_use_moves(root: BaseNode): number {
	if (!move_enabled) return clear_last_use_moves(root);
	let count = 0;
	for (const stamp of collect_stamps(root)) {
		if (stamp.struct_copy) {
			if (rewrite_struct_copy_as_move(stamp.node)) count++;
		} else {
			stamp.node.last_use_move = true;
			count++;
		}
	}
	return count;
}

function clear_last_use_moves(root: BaseNode): number {
	let count = 0;
	const visit = (node: BaseNode): void => {
		if (node.node_type === "declare" || node.node_type === "assign") {
			const n = node as unknown as { last_use_move?: boolean };
			if (n.last_use_move) {
				n.last_use_move = false;
				count++;
			}
			const original = get_last_use_original(node);
			if (original) {
				if (node.node_type === "assign") {
					(node as AssignmentNode).right_value = original;
				} else {
					(node as DeclarationNode).value = original;
				}
				set_last_use_original(node, undefined as unknown as BaseNode);
				count++;
			}
		}
		for (const child of child_nodes(node)) visit(child);
	};
	visit(root);
	return count;
}

interface StampTarget {
	node: DeclarationNode | AssignmentNode;
	/** When set, the stamp is a struct-copy REWRITE (`.copy()` RHS →
	 *  `mv <source>`) rather than a string-move mark. */
	struct_copy?: string;
}

function collect_stamps(root: BaseNode): StampTarget[] {
	const out: StampTarget[] = [];
	const visit_functions = (node: BaseNode): void => {
		if (node.node_type === "func") {
			out.push(...collect_function_stamps(node as unknown as FunctionNode));
		}
		for (const child of child_nodes(node)) visit_functions(child);
	};
	visit_functions(root);
	return out;
}

/** A classification hit: the reported site plus, for struct-copy shapes,
 *  the source name the stamp pass must rewrite to a transfer. */
interface ClassifyHit {
	site: LastUseSite;
	/** Set when the site is a synthesized `.copy()` call at the receiver's
	 *  last use — the stamp pass rewrites the RHS to `mv <struct_copy>`. */
	struct_copy?: string;
}

function collect_function_stamps(func: FunctionNode): StampTarget[] {
	if (!func.statements?.length) return [];
	const walk = new Walk();
	const param_names = new Set(func.params.map((p) => p.name));
	for (const stmt of func.statements) walk_stmt(walk, stmt);
	if (walk.has_raw) return [];
	const func_label = func.label_name ?? func.name;
	const out: StampTarget[] = [];
	for (const assign of walk.assignments) {
		const hit = classify(assign, walk, param_names, func_label);
		if (hit) out.push({ node: assign.node, struct_copy: hit.struct_copy });
	}
	for (const decl of walk.declares) {
		if (!decl.node) continue;
		const hit = classify_declare(decl, walk, param_names, func_label);
		if (hit) out.push({ node: decl.node, struct_copy: hit.struct_copy });
	}
	return out;
}

export interface LastUseSite {
	/** Enclosing function label (or name). */
	func: string;
	/** Assignment target name. */
	target: string;
	/** Moved source name. */
	source: string;
	/** Source-text description of the assignment (`target = source`). */
	desc: string;
}

interface LoopRange {
	enter: number;
	/** Mutated when the loop's walk completes, so earlier reads inside the
	 *  loop share the final range (back-edge coverage). */
	exit: number;
}

interface ReadRecord {
	name: string;
	/** DFS enter stamp — a read is "after" a site when enter > site.exit. */
	enter: number;
	/** References to the enclosing loops' (mutable) ranges. */
	loop_ranges: LoopRange[];
	/** True when the read lives in an execution-order-opaque subtree. */
	opaque: boolean;
}

interface AssignmentRecord {
	node: AssignmentNode;
	enter: number;
	exit: number;
	loop_ranges: LoopRange[];
}

/** A bracket literal (`[a, b]`) whose bare-var element names were recorded
 *  for last-use mv inference. */
interface LiteralRecord {
	node: BaseNode;
	enter: number;
	exit: number;
	loop_ranges: LoopRange[];
	names: string[];
}

interface DeclareRecord {
	name: string;
	declaration: "const" | "var" | "mv" | "view" | "ref";
	enter: number;
	exit: number;
	/** Enclosing loops at the declare site (back-edge coverage). */
	loop_ranges?: LoopRange[];
	/** The AST node, when this declare is a candidate shape (bare-name RHS). */
	node?: DeclarationNode;
}

class Walk {
	private stamp = 0;
	has_raw = false;
	readonly writes: { name: string; enter: number; loop_ranges: LoopRange[] }[] = [];
	readonly reads: ReadRecord[] = [];
	readonly declares: DeclareRecord[] = [];
	readonly assignments: AssignmentRecord[] = [];
	readonly literals: LiteralRecord[] = [];
	private loop_stack: LoopRange[] = [];

	literal(node: BaseNode, names: string[], body: () => void): void {
		const loop_ranges = [...this.loop_stack];
		const enter = ++this.stamp;
		body();
		const exit = ++this.stamp;
		this.literals.push({ node, enter, exit, loop_ranges, names });
	}

	interval<T>(body: () => T): { enter: number; exit: number } {
		const enter = ++this.stamp;
		body();
		const exit = ++this.stamp;
		return { enter, exit };
	}

	loop<T>(body: () => T): void {
		const range: LoopRange = { enter: this.stamp + 1, exit: 0 };
		this.loop_stack.push(range);
		body();
		range.exit = this.stamp; // cover everything the loop walked
		this.loop_stack.pop();
	}

	read(name: string, opaque = false): void {
		this.reads.push({
			name,
			enter: ++this.stamp,
			loop_ranges: [...this.loop_stack],
			opaque,
		});
	}

	assignment(node: AssignmentNode, body: () => void): void {
		const loop_ranges = [...this.loop_stack];
		const enter = ++this.stamp;
		body();
		const exit = ++this.stamp;
		this.assignments.push({ node, enter, exit, loop_ranges });
	}

	write(name: string): void {
		this.writes.push({
			name,
			enter: ++this.stamp,
			loop_ranges: [...this.loop_stack],
		});
	}

	declare(node: DeclarationNode, body: () => void): void {
		const loop_ranges = [...this.loop_stack];
		const enter = ++this.stamp;
		body();
		const exit = ++this.stamp;
		// Keep the node for the two candidate shapes: a bare-name RHS (the
		// string move) and a zero-arg `.copy()` call the checker resolved to
		// a synthesized struct copy (the struct move; post-check only —
		// pre-check trees carry no resolved_function, so this gate simply
		// doesn't match there).
		const value = node.value;
		const bare_name =
			value?.node_type === "value" &&
			typeof (value as ValueNode).value === "string" &&
			/^[A-Za-z_][A-Za-z0-9_]*$/.test((value as ValueNode).value);
		this.declares.push({
			name: node.name,
			declaration: node.declaration,
			enter,
			exit,
			loop_ranges,
			node: bare_name || struct_copy_receiver(value) ? node : undefined,
		});
	}
}

/**
 * Scans every function in the tree (free functions, struct/trait methods;
 * a nested `func` is scanned as its own unit — Nomen has no closures) and
 * reports the mv-on-last-use sites: bare owned-string assignments/declares
 * and synthesized struct `.copy()` calls at the receiver's last use. Run
 * AFTER checking, when expression types are stamped and copy calls carry
 * their resolved function.
 */
export function scan_last_use_string_moves(root: BaseNode): LastUseSite[] {
	const sites: LastUseSite[] = [];
	const visit_functions = (node: BaseNode): void => {
		if (node.node_type === "func") {
			sites.push(...scan_function(node as unknown as FunctionNode));
		}
		for (const child of child_nodes(node)) visit_functions(child);
	};
	visit_functions(root);
	return sites;
}

function scan_function(func: FunctionNode): LastUseSite[] {
	if (!func.statements?.length) return [];
	const walk = new Walk();
	const param_names = new Set(func.params.map((p) => p.name));
	for (const stmt of func.statements) walk_stmt(walk, stmt);

	// A raw `#arch` body may read or write ANY local by name (C bodies use
	// source names; asm reaches slots) — every mv candidate in a function
	// containing one is refused.
	if (walk.has_raw) return [];
	const func_label = func.label_name ?? func.name;
	const sites: LastUseSite[] = [];
	for (const assign of walk.assignments) {
		const hit = classify(assign, walk, param_names, func_label);
		if (hit) sites.push(hit.site);
	}
	for (const decl of walk.declares) {
		if (!decl.node) continue;
		const hit = classify_declare(decl, walk, param_names, func_label);
		if (hit) sites.push(hit.site);
	}
	return sites;
}

/**
 * The bare-variable receiver of a zero-argument `.copy()` call that the
 * checker resolved to the SYNTHESIZED struct deep copy — the
 * move-on-last-use candidate shape. Undefined for everything else (other
 * node kinds, other methods, user-written `copy` methods, non-identifier
 * receivers such as `f().copy()` or `obj.field.copy()`).
 */
function struct_copy_receiver(rhs: BaseNode | undefined): ValueNode | undefined {
	if (!rhs || rhs.node_type !== "access") return undefined;
	const access = rhs as AccessNode;
	if (access.access.node_type !== "access_func") return undefined;
	const af = access.access as AccessFunctionCallNode;
	if (af.name !== "copy" || af.params.length !== 0) return undefined;
	if (!af.resolved_function?.is_synthesized_copy) return undefined;
	const target = access.target;
	if (target.node_type !== "value") return undefined;
	const vn = target as ValueNode;
	if (typeof vn.value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(vn.value)) return undefined;
	return vn;
}

/**
 * The shared last-use test: no read of `source` may execute after the site.
 * Reads inside an enclosing loop kill the candidate ONLY when the binding
 * outlives the loop (declared outside it) — the back edge would re-read
 * that same variable; a loop-local source (`var next = …; acc = next`) is a
 * FRESH binding each iteration, so its textually-earlier reads belong to
 * the previous iteration's dead variable.
 */
function last_use_read_ok(
	source: string,
	site_enter: number,
	site_exit: number,
	site_loop_ranges: LoopRange[],
	binding: DeclareRecord | undefined,
	walk: Walk,
): boolean {
	for (const r of walk.reads) {
		if (r.name !== source) continue;
		if (r.opaque) return false;
		if (r.enter > site_exit) return false; // may execute after
		if (r.enter >= site_enter && r.enter <= site_exit) continue; // the RHS read itself
		for (const loop of site_loop_ranges) {
			if (r.enter >= loop.enter && r.enter <= loop.exit) {
				const binding_in_loop =
					binding !== undefined && binding.enter >= loop.enter && binding.exit <= loop.exit;
				if (!binding_in_loop) return false;
			}
		}
	}
	return true;
}

/**
 * The shared source-side eligibility test: a `var` local (params and consts
 * are not movable), never re-assigned after its binding declare (the
 * backends' reassign paths free the displaced value, which would free the
 * already-transferred state).
 */
function movable_var_source(
	source: string,
	walk: Walk,
	param_names: Set<string>,
): DeclareRecord | undefined {
	if (param_names.has(source)) return undefined; // params are not movable here
	const decl = walk.declares.findLast((d) => d.name === source);
	if (!decl || decl.declaration !== "var") return undefined; // consts are not movable
	const source_write_count = walk.writes.filter((w) => w.name === source).length;
	if (source_write_count > 1) return undefined;
	return decl;
}

function classify(
	assign: AssignmentRecord,
	walk: Walk,
	param_names: Set<string>,
	func_label: string,
): ClassifyHit | undefined {
	const node = assign.node;
	if (node.operator) return undefined; // compound: the RHS is a real use
	if (node.swap) return undefined; // transfer-with-revalidation: explicit spellings only
	if (node.left_value.node_type !== "value") return undefined;
	const target_value = node.left_value as ValueNode;
	const target = target_value.value;
	if (typeof target !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) return undefined;

	if (node.right_value.node_type === "value") {
		// Shape A — bare owned-string variable (`s = t`), the tranche-4 move.
		const source_node = node.right_value as ValueNode;
		const source = source_node.value;
		if (typeof source !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source)) return undefined;
		if (target === source) return undefined;
		if (source_node.is_moved) return undefined; // already an explicit mv
		if (!movable_var_source(source, walk, param_names)) return undefined;
		// Owned string on both sides (checked trees carry stamped types).
		const src_type = source_node.type;
		if (!src_type || src_type.name !== "string" || src_type.is_view || src_type.is_array) {
			return undefined;
		}
		const tgt_type = target_value.type;
		if (!tgt_type || tgt_type.name !== "string" || tgt_type.is_view || tgt_type.is_array) {
			return undefined;
		}

		// The binding this assignment reads: the latest declare of `source`
		// before the assignment site.
		const binding = walk.declares.filter((d) => d.name === source && d.enter < assign.enter).at(-1);

		if (!last_use_read_ok(source, assign.enter, assign.exit, assign.loop_ranges, binding, walk)) {
			return undefined;
		}
		return {
			site: {
				func: func_label,
				target,
				source,
				desc: `${target} = ${source}`,
			},
		};
	}

	// Shape B — `p = q.copy()` where the checker resolved the SYNTHESIZED
	// struct deep copy: when `q` is dead after the site, the deep copy is
	// dead weight and the RHS rewrites to `mv q` (zero field copies).
	const receiver = struct_copy_receiver(node.right_value);
	if (receiver) {
		const source = receiver.value;
		if (target === source) return undefined; // `p = p.copy()` reads itself
		if (receiver.is_moved) return undefined; // already an explicit mv
		// Same struct on both sides (the check that ran already validated
		// the copy's assignability; the stamped types must agree so the
		// transfer lands in a matching slot).
		const src_type = receiver.type;
		const tgt_type = target_value.type;
		if (!src_type?.name || !tgt_type?.name) return undefined;
		if (src_type.name !== tgt_type.name) return undefined;
		if (src_type.is_view || src_type.is_array || tgt_type.is_view || tgt_type.is_array) {
			return undefined;
		}
		if (src_type.is_nullable || tgt_type.is_nullable) return undefined;
		if (!movable_var_source(source, walk, param_names)) return undefined;
		const binding = walk.declares.filter((d) => d.name === source && d.enter < assign.enter).at(-1);
		if (!last_use_read_ok(source, assign.enter, assign.exit, assign.loop_ranges, binding, walk)) {
			return undefined;
		}
		return {
			site: {
				func: func_label,
				target,
				source,
				desc: `${target} = ${source}.copy()`,
			},
			struct_copy: source,
		};
	}
	return undefined;
}

/**
 * Declare-site classification: `var u = t` where t is an owned string local
 * never touched (read OR written) after the declare, and `var u = t.copy()`
 * where the copy is the synthesized struct deep copy and t is dead after.
 * Together with the assignment classification above this covers both
 * mv-on-last-use shapes per family: plain `s = t` reassignment (value
 * semantics would strdup) and the declare alias (`var u = t`) for strings;
 * the whole-RHS deep-copy sites for structs.
 */
function classify_declare(
	decl: DeclareRecord,
	walk: Walk,
	param_names: Set<string>,
	func_label: string,
): ClassifyHit | undefined {
	const node = decl.node;
	if (!node) return undefined;
	if (node.declaration !== "var") return undefined; // consts are not movable
	const value = node.value;
	if (!value) return undefined;

	if (value.node_type === "value") {
		// Shape A — bare owned-string source, the tranche-4 move.
		const source_node = value as ValueNode;
		const source = source_node.value;
		if (source_node.is_moved) return undefined; // already an explicit mv
		if (typeof source !== "string") return undefined;
		if (!movable_var_source(source, walk, param_names)) return undefined;
		const binding = walk.declares.findLast((d) => d.name === source && d.exit < decl.enter);
		if (!binding || binding.declaration !== "var") return undefined;
		// Owned owned-string shapes only (stamped types).
		const src_type = source_node.type;
		if (!src_type || src_type.name !== "string" || src_type.is_view || src_type.is_array) {
			return undefined;
		}
		const tgt_type = node.type;
		if (!tgt_type || tgt_type.name !== "string" || tgt_type.is_view || tgt_type.is_array) {
			return undefined;
		}
		if (!last_use_read_ok(source, decl.enter, decl.exit, decl.loop_ranges ?? [], binding, walk)) {
			return undefined;
		}
		return {
			site: {
				func: func_label,
				target: node.name,
				source,
				desc: `var ${node.name} = ${source}`,
			},
		};
	}

	// Shape B — `var u = t.copy()`, the synthesized struct deep copy at the
	// donor's last use: rewrite to `var u = mv t`.
	const receiver = struct_copy_receiver(value);
	if (receiver) {
		const source = receiver.value;
		if (receiver.is_moved) return undefined;
		if (node.swap) return undefined; // transfer-with-revalidation stays explicit
		// Same struct on both sides (stamped types).
		const src_type = receiver.type;
		const tgt_type = node.type;
		if (!src_type?.name || !tgt_type?.name) return undefined;
		if (src_type.name !== tgt_type.name) return undefined;
		if (src_type.is_view || src_type.is_array || tgt_type.is_view || tgt_type.is_array) {
			return undefined;
		}
		if (src_type.is_nullable || tgt_type.is_nullable) return undefined;
		if (!movable_var_source(source, walk, param_names)) return undefined;
		const binding = walk.declares.findLast((d) => d.name === source && d.exit < decl.enter);
		if (!binding) return undefined;
		if (!last_use_read_ok(source, decl.enter, decl.exit, decl.loop_ranges ?? [], binding, walk)) {
			return undefined;
		}
		return {
			site: {
				func: func_label,
				target: node.name,
				source,
				desc: `var ${node.name} = ${source}.copy()`,
			},
			struct_copy: source,
		};
	}
	return undefined;
}

/**
 * Stamps `literal_last_use_move` on bracket-literal elements (`[a, b]`) that
 * are bare `var` locals at their LAST USE: the literal then TRANSFERS
 * ownership of those locals instead of aliasing them (the checker's
 * tuple-element ownership rule consumes the stamp as an inferred `mv`).
 *
 * Same conservative posture as the string pass: it may MISS a last use (the
 * element then needs an explicit `mv`), never invent one — reads after the
 * literal, reads under an enclosing loop whose binding outlives the loop,
 * reads in spawn/async subtrees, any re-assignment of the source, and any
 * raw `#arch` body in the function all refuse the inference. Types are NOT
 * consulted here (this runs before checking) — the checker applies the
 * mv-type filter when consuming the stamp.
 *
 * Only the FIRST occurrence of a name per literal is stamped: two elements
 * moving the same local would alias each other inside the tuple.
 */
export function stamp_literal_element_moves(root: BaseNode): number {
	if (!move_enabled) return 0;
	let count = 0;
	const visit_functions = (node: BaseNode): void => {
		if (node.node_type === "func") {
			count += scan_function_literal_element_moves(node as unknown as FunctionNode);
		}
		for (const child of child_nodes(node)) visit_functions(child);
	};
	visit_functions(root);
	return count;
}

function scan_function_literal_element_moves(func: FunctionNode): number {
	if (!func.statements?.length) return 0;
	const walk = new Walk();
	const param_names = new Set(func.params.map((p) => p.name));
	for (const stmt of func.statements) walk_stmt(walk, stmt);
	if (walk.has_raw) return 0;
	let count = 0;
	for (const site of walk.literals) {
		const eligible: string[] = [];
		for (const name of site.names) {
			if (eligible.includes(name)) continue; // second transfer of one local aliases itself
			if (param_names.has(name)) continue; // params are not movable here
			const binding = walk.declares.filter((d) => d.name === name && d.enter < site.enter).at(-1);
			if (!binding || binding.declaration !== "var") continue; // consts are not movable
			const write_count = walk.writes.filter((w) => w.name === name).length;
			if (write_count > 1) continue; // re-assignment refuses the transfer
			let killed = false;
			for (const r of walk.reads) {
				if (r.name !== name) continue;
				if (r.opaque) {
					killed = true;
					break;
				}
				if (r.enter > site.exit) {
					killed = true;
					break;
				}
				if (r.enter >= site.enter && r.enter <= site.exit) continue; // the element read itself
				for (const loop of site.loop_ranges) {
					if (r.enter >= loop.enter && r.enter <= loop.exit) {
						// A read inside an enclosing loop kills the candidate
						// unless the binding is loop-local (a fresh binding
						// each iteration; the back edge re-reads a dead var).
						const binding_in_loop = binding.enter >= loop.enter && binding.exit <= loop.exit;
						if (!binding_in_loop) {
							killed = true;
							break;
						}
					}
				}
				if (killed) break;
			}
			if (!killed) eligible.push(name);
		}
		const values = (site.node as unknown as { values: BaseNode[] }).values;
		for (const v of values) {
			const vn = v as ValueNode;
			if (vn.node_type === "value" && typeof vn.value === "string" && eligible.includes(vn.value)) {
				(vn as unknown as { literal_last_use_move?: boolean }).literal_last_use_move = true;
				count++;
			}
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// Statement / expression walk
// ---------------------------------------------------------------------------

function walk_stmt(walk: Walk, node: BaseNode): void {
	// Checker-hoisted interpolation args ride as `node.allocations` declare
	// statements (`const _param_N = x.to_string()`) that the block builder
	// emits BEFORE this statement. Their bodies READ the sources they wrap —
	// an interpolation of `own` after an `owns = own` assignment is a real
	// later read, so the hoisted declares must be walked here (at the
	// carrying statement's position) or the mv candidates' last-use test
	// never sees those reads.
	if (node.allocations?.length) {
		for (const alloc of node.allocations) walk_stmt(walk, alloc);
	}
	switch (node.node_type) {
		case "declare": {
			const decl = node as unknown as {
				name: string;
				declaration: "const" | "var";
				value?: BaseNode;
				swap?: BaseNode;
				func_params?: unknown;
			};
			if (decl.func_params) return; // func-typed declare: value is a lambda
			walk.declare(decl as DeclarationNode, () => {
				if (decl.value) walk_expr(walk, decl.value!);
				if (decl.swap) walk_expr(walk, decl.swap!);
			});
			// A redeclaration of the same name is a write of the outer
			// binding's slot model — record it so mv sites refuse.
			walk.write(decl.name);
			return;
		}
		case "assign": {
			const assign = node as AssignmentNode;
			walk.assignment(assign, () => {
				// A plain (non-compound) whole-variable target is a WRITE, not
				// a read. A compound target (x += …) reads.
				const target_name =
					assign.left_value.node_type === "value"
						? (assign.left_value as ValueNode).value
						: undefined;
				if (
					!assign.operator &&
					typeof target_name === "string" &&
					/^[A-Za-z_][A-Za-z0-9_]*$/.test(target_name)
				) {
					walk.write(target_name);
				}
				walk_lhs(walk, assign.left_value, !!assign.operator);
				walk_expr(walk, assign.right_value);
				if (assign.swap) walk_expr(walk, assign.swap);
			});
			return;
		}
		case "op": {
			walk.interval(() => walk_expr(walk, node));
			return;
		}
		case "if": {
			const if_else = node as unknown as {
				condition: BaseNode;
				if_branch?: { statements: BaseNode[] };
				else_branch?: { statements: BaseNode[] };
			};
			walk.interval(() => {
				if (if_else.condition) walk_expr(walk, if_else.condition);
				for (const s of if_else.if_branch?.statements ?? []) walk_stmt(walk, s);
				for (const s of if_else.else_branch?.statements ?? []) walk_stmt(walk, s);
			});
			return;
		}
		case "while": {
			const wh = node as unknown as {
				condition: BaseNode;
				statements: BaseNode[];
				update?: BaseNode;
			};
			walk.loop(() => {
				walk_expr(walk, wh.condition);
				for (const s of wh.statements) walk_stmt(walk, s);
				if (wh.update) walk_expr(walk, wh.update);
			});
			return;
		}
		case "for": {
			const fl = node as unknown as {
				item: BaseNode;
				list: BaseNode;
				statements: BaseNode[];
				update?: BaseNode;
				index?: BaseNode;
			};
			walk.loop(() => {
				walk_expr(walk, fl.list);
				walk_expr(walk, fl.item);
				for (const s of fl.statements) walk_stmt(walk, s);
				if (fl.update) walk_expr(walk, fl.update);
				if (fl.index) walk_expr(walk, fl.index);
			});
			return;
		}
		case "return":
		case "let": {
			const value = (node as unknown as { value?: BaseNode }).value;
			if (value) walk.interval(() => walk_expr(walk, value));
			return;
		}
		case "switch": {
			const sw = node as unknown as {
				cases: { condition: BaseNode; branch: { statements: BaseNode[] } }[];
			};
			walk.interval(() => {
				for (const c of sw.cases) {
					walk_expr(walk, c.condition);
					for (const s of c.branch.statements) walk_stmt(walk, s);
				}
			});
			return;
		}
		case "match": {
			const m = node as unknown as {
				value: BaseNode;
				cases: { match_value: BaseNode; branch: { statements: BaseNode[] } }[];
				else_branch?: { statements: BaseNode[] };
			};
			walk.interval(() => {
				walk_expr(walk, m.value);
				for (const c of m.cases) {
					walk_expr(walk, c.match_value);
					for (const s of c.branch.statements) walk_stmt(walk, s);
				}
				for (const s of m.else_branch?.statements ?? []) walk_stmt(walk, s);
			});
			return;
		}
		case "access": {
			// A bare method-call statement (e.g. `sb.append(x)`).
			walk.interval(() => walk_expr(walk, node));
			return;
		}
		case "raw": {
			walk.has_raw = true;
			return;
		}
		case "spawn":
		case "async_block": {
			// Execution-order opaque: every name mentioned is an always-live
			// read (opaque flag + enter -1 sorts before any site).
			for (const name of subtree_names(node)) walk.read(name, true);
			return;
		}
		default: {
			// raw / break / continue / panic / nested func declarations —
			// nothing the analysis models. (A nested `func` is scanned as its
			// own unit; Nomen has no closures, so its reads resolve against
			// ITS locals, not the enclosing frame.)
			return;
		}
	}
}

function walk_lhs(walk: Walk, node: BaseNode, compound: boolean): void {
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		if (compound && typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			walk.read(name); // x += … reads x
		}
		return;
	}
	walk_expr(walk, node);
}

function walk_expr(walk: Walk, node: BaseNode): void {
	switch (node.node_type) {
		case "value": {
			const vn = node as ValueNode;
			if (
				typeof vn.value === "string" &&
				/^[A-Za-z_][A-Za-z0-9_]*$/.test(vn.value) &&
				vn.value !== "null" &&
				vn.value !== "true" &&
				vn.value !== "false"
			) {
				walk.read(vn.value);
			}
			return;
		}
		case "access": {
			const access = node as AccessNode;
			// The chain's ROOT is a read (a.b.c reads a); field/method names
			// carry no reads, the arguments do.
			walk_expr(walk, access.target);
			if (access.access.node_type === "access_func") {
				const af = access.access as unknown as { params: BaseNode[] };
				for (const p of af.params) walk_expr(walk, p);
			}
			return;
		}
		case "op": {
			const op = node as OperationNode;
			walk_expr(walk, op.left_value);
			walk_expr(walk, op.right_value);
			return;
		}
		case "grouped": {
			walk_expr(walk, (node as unknown as { value: BaseNode }).value);
			return;
		}
		case "func_call": {
			const fc = node as unknown as { params: BaseNode[] };
			for (const p of fc.params) walk_expr(walk, p);
			return;
		}
		case "array": {
			const arr = node as unknown as { values: BaseNode[] };
			const names = arr.values
				.map((v) => v as ValueNode)
				.filter(
					(v) =>
						v.node_type === "value" &&
						typeof v.value === "string" &&
						/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.value),
				)
				.map((v) => v.value as string);
			walk.literal(node, names, () => {
				for (const v of arr.values) walk_expr(walk, v);
			});
			return;
		}
		default: {
			// cast / let expressions / func literals: walk children generically
			// so nothing that reads is silently skipped.
			for (const child of child_nodes(node)) walk_expr(walk, child);
		}
	}
}

function subtree_names(node: BaseNode): string[] {
	const names: string[] = [];
	const visit = (n: BaseNode): void => {
		if (n.node_type === "value") {
			const v = (n as ValueNode).value;
			if (typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) names.push(v);
		}
		for (const child of child_nodes(n)) visit(child);
	};
	visit(node);
	return names;
}
