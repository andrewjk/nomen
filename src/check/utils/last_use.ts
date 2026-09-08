import AccessNode from "../../nodes/AccessNode.ts";
import type AssignmentNode from "../../nodes/AssignmentNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import { child_nodes } from "../../nodes/child_nodes.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import type ValueNode from "../../nodes/ValueNode.ts";

/**
 * Checker-level LAST-USE analysis for move-on-last-use string assignment
 * (STRING_PLAN tranche 4's gate receipt).
 *
 * `s = t` where `t` is a plain owned `string` local strdups t's bytes only
 * because both sides would otherwise own them. When `t` is never READ again
 * after the assignment, the copy is dead weight: transfer the pair and mark
 * `t` moved instead. This module MEASURES how often that shape occurs in a
 * real program — the tranche's stated gate ("a checker-level last-use
 * receipt on a real pattern first; do not start without it") — and is
 * structured so the builders can later consume the same verdict
 * (`AssignmentNode.last_use_move`) without re-deriving it.
 *
 * Soundness posture (conservative: it may MISS a last-use, never invent
 * one):
 *   - any read of `t` textually after the assignment counts against it —
 *     including reads in sibling branches (one may execute after the
 *     other; the DFS order only ever RELAXES the then/else case in the
 *     sound direction: an assignment visited after a sibling-branch read
 *     is refused, never the reverse),
 *   - any read of `t` ANYWHERE inside a loop that encloses the assignment
 *     counts (reads before the site too: the back edge re-executes them),
 *   - any read inside a spawn / async subtree is execution-order opaque
 *     and counts,
 *   - `t` must be a `var` local (params and consts are not movable here),
 *     an owned non-view string, and the assignment must be plain
 *     (`s = t`, no compound operator) with `t` as the ENTIRE right side.
 */

let move_enabled = true;

/** Kill-switch for the move-on-last-use emission (default ON). OFF = the
 *  stamping pass clears its marks and the backends keep the strdup'd copy —
 *  output byte-identical to the pre-tranche compiler. */
export function set_move_on_last_use_enabled(enabled: boolean): void {
	move_enabled = enabled;
}

export function move_on_last_use_enabled(): boolean {
	return move_enabled;
}

/**
 * Stamps `last_use_move` on candidate declare/assignment nodes across the
 * tree. Run once per build, after checking (types are stamped). With the
 * kill-switch OFF, existing stamps are CLEARED so repeated builds of a
 * shared AST stay deterministic. Returns the number of stamps.
 */
export function stamp_last_use_moves(root: BaseNode): number {
	if (!move_enabled) return clear_last_use_moves(root);
	let count = 0;
	for (const stamp of collect_stamps(root)) {
		stamp.node.last_use_move = true;
		count++;
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
		}
		for (const child of child_nodes(node)) visit(child);
	};
	visit(root);
	return count;
}

interface StampTarget {
	node: DeclarationNode | AssignmentNode;
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

function collect_function_stamps(func: FunctionNode): StampTarget[] {
	if (!func.statements?.length) return [];
	const walk = new Walk();
	const param_names = new Set(func.params.map((p) => p.name));
	for (const stmt of func.statements) walk_stmt(walk, stmt);
	if (walk.has_raw) return [];
	const func_label = func.label_name ?? func.name;
	const out: StampTarget[] = [];
	for (const assign of walk.assignments) {
		if (classify(assign, walk, param_names, func_label)) out.push({ node: assign.node });
	}
	for (const decl of walk.declares) {
		if (!decl.node) continue;
		if (classify_declare(decl, walk, param_names, func_label)) {
			out.push({ node: decl.node });
		}
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

interface DeclareRecord {
	name: string;
	declaration: "const" | "var" | "mov" | "view";
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
	private loop_stack: LoopRange[] = [];

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
		this.writes.push({ name, enter: ++this.stamp, loop_ranges: [...this.loop_stack] });
	}

	declare(node: DeclarationNode, body: () => void): void {
		const loop_ranges = [...this.loop_stack];
		const enter = ++this.stamp;
		body();
		const exit = ++this.stamp;
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
			node: bare_name ? node : undefined,
		});
	}
}

/**
 * Scans every function in the tree (free functions, struct/trait methods;
 * a nested `func` is scanned as its own unit — Nomen has no closures) and
 * reports the move-on-last-use sites. Run AFTER checking, when expression
 * types are stamped.
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
	// source names; asm reaches slots) — every move candidate in a function
	// containing one is refused.
	if (walk.has_raw) return [];
	const func_label = func.label_name ?? func.name;
	const sites: LastUseSite[] = [];
	for (const assign of walk.assignments) {
		const site = classify(assign, walk, param_names, func_label);
		if (site) sites.push(site);
	}
	for (const decl of walk.declares) {
		if (!decl.node) continue;
		const site = classify_declare(decl, walk, param_names, func_label);
		if (site) sites.push(site);
	}
	return sites;
}

function classify(
	assign: AssignmentRecord,
	walk: Walk,
	param_names: Set<string>,
	func_label: string,
): LastUseSite | undefined {
	const node = assign.node;
	if (node.operator) return undefined; // compound: the RHS is a real use
	if (node.right_value.node_type !== "value") return undefined;
	const source_node = node.right_value as ValueNode;
	const source = source_node.value;
	if (typeof source !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source)) return undefined;
	if (node.left_value.node_type !== "value") return undefined;
	const target = (node.left_value as ValueNode).value;
	if (target === source) return undefined;
	if (source_node.is_moved) return undefined; // already an explicit move
	if (param_names.has(source)) return undefined; // params are not movable here
	const decl = walk.declares.findLast((d) => d.name === source);
	if (!decl || decl.declaration !== "var") return undefined; // consts are not movable
	// A re-assignment (write) of the source beyond its own binding declare
	// refuses the move: the backends' reassign paths free the displaced value,
	// which would free the already-transferred block (C's moved_string_vars
	// suppression is not consulted by the eager reassign free). Mirrors
	// classify_declare's write_count check. (Every declare records one write —
	// its own binding — so a plain `var t = …` counts exactly once.)
	const source_write_count = walk.writes.filter((w) => w.name === source).length;
	if (source_write_count > 1) return undefined;
	// Owned string on both sides (checked trees carry stamped types).
	const src_type = source_node.type;
	if (!src_type || src_type.name !== "string" || src_type.is_view || src_type.is_array) {
		return undefined;
	}
	const tgt_type = (node.left_value as ValueNode).type;
	if (!tgt_type || tgt_type.name !== "string" || tgt_type.is_view || tgt_type.is_array) {
		return undefined;
	}

	// The binding this assignment reads: the latest declare of `source`
	// before the assignment site.
	const binding = walk.declares.filter((d) => d.name === source && d.enter < assign.enter).at(-1);

	// Last-use test.
	for (const r of walk.reads) {
		if (r.name !== source) continue;
		if (r.opaque) return undefined;
		if (r.enter > assign.exit) return undefined; // may execute after
		if (r.enter >= assign.enter && r.enter <= assign.exit) continue; // the RHS read itself
		for (const loop of assign.loop_ranges) {
			if (r.enter >= loop.enter && r.enter <= loop.exit) {
				// A read inside an enclosing loop kills the candidate ONLY
				// when the binding outlives the loop (declared outside it) —
				// the back edge would re-read that same variable. A
				// loop-local source (`var next = …; acc = next`) is a FRESH
				// binding each iteration: its textually-earlier reads belong
				// to the previous iteration's dead variable.
				const binding_in_loop =
					binding !== undefined && binding.enter >= loop.enter && binding.exit <= loop.exit;
				if (!binding_in_loop) return undefined;
			}
		}
	}
	return {
		func: func_label,
		target,
		source,
		desc: `${target} = ${source}`,
	};
}

/**
 * Declare-site classification: `var u = t` where t is an owned string local
 * never touched (read OR written) after the declare. Together with the
 * assignment classification above this covers both move-on-last-use shapes:
 * plain `s = t` reassignment (value semantics would strdup) and the declare
 * alias (`var u = t`).
 */
function classify_declare(
	decl: DeclareRecord,
	walk: Walk,
	param_names: Set<string>,
	func_label: string,
): LastUseSite | undefined {
	const node = decl.node;
	if (!node) return undefined;
	if (node.declaration !== "var") return undefined; // consts are not movable
	const source_node = node.value as ValueNode;
	const source = source_node.value;
	if (source_node.is_moved) return undefined; // already an explicit move
	if (param_names.has(source)) return undefined; // params are not movable here
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
	// The source's only write must be its own binding declare.
	const write_count = walk.writes.filter((w) => w.name === source).length;
	if (write_count > 1) return undefined;
	// Nothing after the declare may touch the source.
	for (const r of walk.reads) {
		if (r.name !== source) continue;
		if (r.opaque) return undefined;
		if (r.enter > decl.exit) return undefined;
		if (r.enter >= decl.enter && r.enter <= decl.exit) continue; // the RHS read
		for (const loop of decl.loop_ranges ?? []) {
			if (r.enter >= loop.enter && r.enter <= loop.exit) {
				const binding_in_loop = binding.enter >= loop.enter && binding.exit <= loop.exit;
				if (!binding_in_loop) return undefined;
			}
		}
	}
	return {
		func: func_label,
		target: node.name,
		source,
		desc: `var ${node.name} = ${source}`,
	};
}

// ---------------------------------------------------------------------------
// Statement / expression walk
// ---------------------------------------------------------------------------

function walk_stmt(walk: Walk, node: BaseNode): void {
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
			// binding's slot model — record it so move sites refuse.
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
				walk_expr(walk, if_else.condition);
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
			for (const v of arr.values) walk_expr(walk, v);
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
