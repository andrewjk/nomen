import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type AssignmentNode from "../../nodes/AssignmentNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import { child_nodes } from "../../nodes/child_nodes.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import type FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import type ReturnNode from "../../nodes/ReturnNode.ts";
import type Type from "../../nodes/Type.ts";
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
 *    a copyable value struct — a user-written `copy` never carries the new
 *    `FunctionNode.is_synthesized_copy` marker, so arbitrary `copy` methods
 *    are never touched) deep-copies every field — a strdup per string
 *    field, a fresh container per `List` field. When `b` is genuinely dead
 *    after the site, the deep copy is dead weight: the RHS is REWRITTEN to
 *    `mv b`, and the explicit-transfer lowering both backends already
 *    implement (donor cleanup suppressed, displaced-value reclaim kept)
 *    does the rest.
 *
 * 3. The other ownership-transfer positions (PERF_PLAN item 3's remainder).
 *    The same test and rewrite apply wherever a synthesized struct
 *    `.copy()` is the whole transferred value:
 *      - `return src.copy()`          → `return mv src`
 *      - container stores             → `list.push(mv src)` (the checked
 *        `push`/`add` value parameter is `mv T`, so the rewritten argument
 *        is the explicit donor spelling; the checker-hoisted `_param_N`
 *        temp and its copy drop out of the statement's allocations)
 *      - field stores                 → `obj.field = mv src`
 *    Plus the container-typed donor sibling: `var dst = list.copy()` where
 *    `list` is a `List`/`Map`/`Set` `var` local — the library copy has the
 *    same fresh-value shape and the container `mv` transfer exists. A
 *    free-function call argument rewrites ONLY when the callee parameter
 *    is `mv`-declared (the checker rejects `mv` into a borrow parameter,
 *    so anything else would build a spelling the language refuses).
 *
 *    The builder-side lowerings for all of these are the explicit-`mv`
 *    paths (consume `is_moved` / `move_param_indices` at build time), and
 *    one site per function donates a given name: sites are processed in
 *    program order and an already-moved donor refuses later sites (the
 *    truly-last use is the one rewritten).

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

/** Non-enumerable field names holding the ORIGINAL `.copy()` RHS of a
 *  rewritten declare/assign/return — and, for rewritten call arguments, the
 *  original param node plus enough bookkeeping to put the checker-hoisted
 *  `_param_N` allocation back. The kill-switch (move_enabled OFF) restores
 *  them so a rebuilt AST emits the deep copy again. Non-enumerable like
 *  set_resolved_function: node-valued fields must stay invisible to the
 *  reflective walkers (child_nodes, Object.keys scans) or the detached
 *  originals would be walked twice. */
const LAST_USE_ORIGINAL = "last_use_move_original";
const LAST_USE_PARAM = "last_use_move_param";

interface LastUseParamRecord {
	index: number;
	/** The checker-hoisted `const _param_N = <src>.copy()` declare. */
	alloc: DeclarationNode;
	/** The live statement allocations array the alloc was spliced from. */
	allocs: BaseNode[];
	/** Where to re-insert the alloc on restore. */
	alloc_index: number;
}

function set_hidden(node: BaseNode, key: string, value: unknown): void {
	Object.defineProperty(node, key, {
		value,
		enumerable: false,
		writable: true,
		configurable: true,
	});
}

function get_hidden<T>(node: BaseNode, key: string): T | undefined {
	return (node as unknown as Record<string, unknown>)[key] as T | undefined;
}

function set_last_use_original(node: BaseNode, original: BaseNode): void {
	set_hidden(node, LAST_USE_ORIGINAL, original);
}

function get_last_use_original(node: BaseNode): BaseNode | undefined {
	return get_hidden<BaseNode>(node, LAST_USE_ORIGINAL);
}

function set_last_use_param(node: BaseNode, record: LastUseParamRecord): void {
	set_hidden(node, LAST_USE_PARAM, record);
}

function get_last_use_param(node: BaseNode): LastUseParamRecord | undefined {
	return get_hidden<LastUseParamRecord>(node, LAST_USE_PARAM);
}

/** Rewrite a classified struct/container-copy site whose transferred value
 *  is a whole RHS (declare / assign / return): the `.copy()` value is
 *  replaced by `mv <source>` (a bare moved ValueNode), the exact AST shape a
 *  hand-written transfer produces, so both backends' tested mv lowerings
 *  (donor cleanup suppressed, displaced-value reclaim kept) do the work.
 *  Idempotent: a re-stamp of the rewritten tree finds no `.copy()` call and
 *  refuses. */
function rewrite_value_as_move(node: DeclarationNode | AssignmentNode | ReturnNode): boolean {
	const rhs =
		node.node_type === "return"
			? (node as ReturnNode).value
			: node.node_type === "assign"
				? (node as AssignmentNode).right_value
				: (node as DeclarationNode).value;
	if (!rhs) return false;
	const receiver = copy_receiver(rhs);
	if (!receiver) return false; // already rewritten (or a stale hit) — nothing to do
	const moved = moved_value_node(receiver.receiver);
	set_last_use_original(node, rhs);
	if (node.node_type === "return") {
		(node as ReturnNode).value = moved;
	} else if (node.node_type === "assign") {
		(node as AssignmentNode).right_value = moved;
	} else {
		(node as DeclarationNode).value = moved;
	}
	return true;
}

/** Rewrite a classified call-argument site: the checker-hoisted
 *  `const _param_N = src.copy()` allocation is spliced out of the
 *  statement's allocations, the parameter becomes the bare `mv src` donor
 *  (stamping `move_param_indices` — the exact AST the explicit spelling
 *  `f(mv src)` / `recv.push(mv src)` parses into, whose donor-cleanup
 *  lowerings both backends already implement), and the hoisted temp and its
 *  copy drop out entirely. Idempotent: the allocation is gone on re-stamp. */
function rewrite_call_param_as_move(
	node: FunctionCallNode | AccessFunctionCallNode,
	record: LastUseParamRecord,
): boolean {
	const receiver = copy_receiver(record.alloc.value);
	if (!receiver) return false; // stale hit
	const moved = moved_value_node(receiver.receiver);
	set_last_use_original(node, node.params[record.index]);
	set_last_use_param(node, record);
	node.params[record.index] = moved;
	if (!node.move_param_indices) node.move_param_indices = [];
	if (!node.move_param_indices.includes(record.index)) node.move_param_indices.push(record.index);
	record.allocs.splice(record.alloc_index, 1);
	return true;
}

function moved_value_node(receiver: ValueNode): ValueNode {
	const moved = new ValueNode(receiver.start, receiver.value, receiver.type);
	moved.is_moved = true;
	return moved;
}

/**
 * Stamps `last_use_move` on candidate declare/assignment nodes across the
 * tree (string sources), and REWRITES struct/container `.copy()` sites whose
 * source is proven dead after into explicit `mv` transfers (whole-RHS
 * positions, returns, field stores, and call arguments). Run once per
 * build, after checking (types are stamped). With the kill-switch OFF,
 * existing stamps are CLEARED and rewrites are RESTORED so repeated builds
 * of a shared AST stay deterministic. Returns the number of stamps.
 */
export function stamp_last_use_moves(root: BaseNode): number {
	if (!move_enabled) return clear_last_use_moves(root);
	let count = 0;
	for (const stamp of collect_stamps(root)) {
		if (stamp.param) {
			if (rewrite_call_param_as_move(stamp.param.node, stamp.param.record)) count++;
		} else if (stamp.struct_copy) {
			if (rewrite_value_as_move(stamp.node)) count++;
		} else if (stamp.node.node_type !== "return") {
			(stamp.node as AssignmentNode | DeclarationNode).last_use_move = true;
			count++;
		}
	}
	return count;
}

function clear_last_use_moves(root: BaseNode): number {
	let count = 0;
	const visit = (node: BaseNode): void => {
		if (
			node.node_type === "declare" ||
			node.node_type === "assign" ||
			node.node_type === "return"
		) {
			const n = node as unknown as { last_use_move?: boolean };
			if (n.last_use_move) {
				n.last_use_move = false;
				count++;
			}
		}
		const original = get_last_use_original(node);
		if (original) {
			const param = get_last_use_param(node);
			if (param) {
				// A rewritten call argument: restore the hoisted-temp param,
				// put the allocation back at its original index, and drop the
				// move_param_indices stamp.
				(node as unknown as { params: BaseNode[] }).params[param.index] = original;
				param.allocs.splice(param.alloc_index, 0, param.alloc);
				const indices = (node as unknown as { move_param_indices?: number[] }).move_param_indices;
				if (indices) {
					const at = indices.indexOf(param.index);
					if (at !== -1) indices.splice(at, 1);
				}
				set_last_use_param(node, undefined as unknown as LastUseParamRecord);
			} else if (node.node_type === "assign") {
				(node as AssignmentNode).right_value = original;
			} else if (node.node_type === "return") {
				(node as ReturnNode).value = original;
			} else {
				(node as DeclarationNode).value = original;
			}
			set_last_use_original(node, undefined as unknown as BaseNode);
			count++;
		}
		for (const child of child_nodes(node)) visit(child);
	};
	visit(root);
	return count;
}

interface StampTarget {
	node: DeclarationNode | AssignmentNode | ReturnNode;
	/** When set, the stamp is a struct/container-copy REWRITE (`.copy()`
	 *  value → `mv <source>`) rather than a string-move mark. */
	struct_copy?: string;
	/** When set, the stamp is a call-argument REWRITE (the hoisted
	 *  `_param_N` copy allocation drops out; the param becomes the bare
	 *  `mv <source>` donor). */
	param?: {
		node: FunctionCallNode | AccessFunctionCallNode;
		record: LastUseParamRecord;
	};
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

/** A classification hit: the reported site plus, for copy shapes, the
 *  rewrite the stamp pass must perform. */
interface ClassifyHit {
	site: LastUseSite;
	/** Set when the site is a synthesized `.copy()` (or a List/Map/Set
	 *  library copy) at the receiver's last use in a whole-RHS position —
	 *  the stamp pass rewrites the value to `mv <struct_copy>`. */
	struct_copy?: string;
	/** Set when the site is a call argument whose hoisted `_param_N`
	 *  allocation is the donor's last-use copy — the stamp pass splices the
	 *  allocation and rewrites the param to the bare `mv` donor. */
	param?: {
		node: FunctionCallNode | AccessFunctionCallNode;
		record: LastUseParamRecord;
	};
}

/** A raw candidate site in program order. Classification and rewriting run
 *  in this order so a donor moved by an earlier site refuses later ones
 *  (the truly-last use is the one rewritten — two `x.copy()` declares in a
 *  row must keep the FIRST as a real copy). */
type RawSite =
	| { kind: "assign"; enter: number; rec: AssignmentRecord }
	| { kind: "declare"; enter: number; rec: DeclareRecord }
	| { kind: "return"; enter: number; rec: ReturnRecord }
	| { kind: "call"; enter: number; rec: CallRecord };

function function_raw_sites(walk: Walk): RawSite[] {
	const sites: RawSite[] = [];
	for (const rec of walk.assignments) sites.push({ kind: "assign", enter: rec.enter, rec });
	for (const rec of walk.declares) sites.push({ kind: "declare", enter: rec.enter, rec });
	for (const rec of walk.returns) sites.push({ kind: "return", enter: rec.enter, rec });
	for (const rec of walk.calls) sites.push({ kind: "call", enter: rec.enter, rec });
	sites.sort((a, b) => a.enter - b.enter);
	return sites;
}

function collect_function_stamps(func: FunctionNode): StampTarget[] {
	if (!func.statements?.length) return [];
	const { walk, param_names } = walk_function(func);
	if (walk.has_raw) return [];
	const func_label = func.label_name ?? func.name;
	const out: StampTarget[] = [];
	const moved = new Set<string>();
	for (const site of function_raw_sites(walk)) {
		const hit = classify_site(site, walk, param_names, func_label, moved);
		if (!hit) continue;
		if (hit.param) {
			out.push({
				node: hit.param.node as unknown as DeclarationNode,
				param: hit.param,
			});
		} else if (hit.struct_copy) {
			out.push({
				node: site.rec.node as DeclarationNode | AssignmentNode | ReturnNode,
				struct_copy: hit.struct_copy,
			});
		} else {
			out.push({ node: site.rec.node as AssignmentNode | DeclarationNode });
		}
	}
	return out;
}

function walk_function(func: FunctionNode): { walk: Walk; param_names: Set<string> } {
	const walk = new Walk();
	const param_names = new Set(func.params.map((p) => p.name));
	for (const stmt of func.statements) walk_stmt(walk, stmt);
	return { walk, param_names };
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

interface ReturnRecord {
	node: ReturnNode;
	enter: number;
	exit: number;
	loop_ranges: LoopRange[];
}

interface CallRecord {
	node: FunctionCallNode | AccessFunctionCallNode;
	/** Source-text spelling of the call (`fill`, `list.push`) for the site
	 *  description. */
	spell: string;
	enter: number;
	exit: number;
	loop_ranges: LoopRange[];
	/** The enclosing statements' live `allocations` arrays (nearest first) —
	 *  where the checker parked this call's hoisted `_param_N` copies. The
	 *  arrays are LIVE references, so the rewrite's splice-out lands on the
	 *  AST. */
	alloc_frames: BaseNode[][];
}

class Walk {
	stamp = 0;
	has_raw = false;
	readonly writes: { name: string; enter: number; loop_ranges: LoopRange[] }[] = [];
	readonly reads: ReadRecord[] = [];
	readonly declares: DeclareRecord[] = [];
	readonly assignments: AssignmentRecord[] = [];
	readonly literals: LiteralRecord[] = [];
	readonly returns: ReturnRecord[] = [];
	readonly calls: CallRecord[] = [];
	loop_stack: LoopRange[] = [];
	alloc_frames: BaseNode[][] = [];

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
		// a synthesized struct copy or a container library copy (the
		// struct/container move; post-check only — pre-check trees carry no
		// resolved_function, so this gate simply doesn't match there).
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
			node: bare_name || copy_receiver(value) ? node : undefined,
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
	const { walk, param_names } = walk_function(func);
	if (walk.has_raw) return [];
	const func_label = func.label_name ?? func.name;
	const sites: LastUseSite[] = [];
	const moved = new Set<string>();
	for (const site of function_raw_sites(walk)) {
		const hit = classify_site(site, walk, param_names, func_label, moved);
		if (hit) sites.push(hit.site);
	}
	return sites;
}

/** The bare-variable receiver of a zero-argument `.copy()` call that the
 *  checker resolved to a fresh-value deep copy at a movable donor — the
 *  move-on-last-use candidate shape. Two flavors:
 *    - `container: false` — the SYNTHESIZED struct deep copy
 *      (`is_synthesized_copy`; a user-written `copy` never carries it).
 *    - `container: true` — the List/Map/Set library copy, the
 *      container-typed donor sibling (a user struct named `List` cannot
 *      exist; the receiver's stamped type names the container).
 *  Undefined for everything else (other node kinds, other methods,
 *  non-identifier receivers such as `f().copy()` or `obj.field.copy()`). */
function copy_receiver(
	rhs: BaseNode | undefined,
): { receiver: ValueNode; container: boolean } | undefined {
	if (!rhs || rhs.node_type !== "access") return undefined;
	const access = rhs as AccessNode;
	if (access.access.node_type !== "access_func") return undefined;
	const af = access.access as AccessFunctionCallNode;
	if (af.name !== "copy" || af.params.length !== 0) return undefined;
	if (!af.resolved_function) return undefined;
	const target = access.target;
	if (target.node_type !== "value") return undefined;
	const vn = target as ValueNode;
	if (typeof vn.value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(vn.value)) return undefined;
	if (af.resolved_function.is_synthesized_copy) return { receiver: vn, container: false };
	const tname = vn.type?.name ?? af.resolved_function.return_type?.name;
	if (tname === "List" || tname === "Map" || tname === "Set") {
		return { receiver: vn, container: true };
	}
	return undefined;
}

/**
 * The shared last-use test: no read of `source` may execute after the site.
 * `skip_enter`/`skip_exit` bracket the copy expression ITSELF (its receiver
 * read lives there and never counts); every other read up to `boundary_exit`
 * — the end of the whole statement/call the rewrite happens inside — refuses
 * the candidate. Reads inside an enclosing loop kill the candidate ONLY when
 * the binding outlives the loop (declared outside it) — the back edge would
 * re-read that same variable; a loop-local source (`var next = …; acc =
 * next`) is a FRESH binding each iteration, so its textually-earlier reads
 * belong to the previous iteration's dead variable.
 */
function last_use_read_ok(
	source: string,
	skip_enter: number,
	skip_exit: number,
	boundary_exit: number,
	site_loop_ranges: LoopRange[],
	binding: DeclareRecord | undefined,
	walk: Walk,
): boolean {
	for (const r of walk.reads) {
		if (r.name !== source) continue;
		if (r.opaque) return false;
		if (r.enter > boundary_exit) return false; // may execute after
		if (r.enter >= skip_enter && r.enter <= skip_exit) continue; // the copy's own receiver read
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

/** Spell an assignment target for the site description (`p`, `obj.field`). */
function target_text(node: BaseNode): string {
	if (node.node_type === "value") return String((node as ValueNode).value);
	if (node.node_type === "access") {
		const access = node as AccessNode;
		const base = target_text(access.target);
		if (access.access.node_type === "access_field") {
			return `${base}.${(access.access as unknown as { name: string }).name}`;
		}
	}
	return "?";
}

function is_field_target(node: BaseNode): boolean {
	return node.node_type === "access" && (node as AccessNode).access.node_type === "access_field";
}

/** The shared donor gates for a struct/container copy site: same type on
 *  both sides (stamped), a `var` local donor, not already moved by an
 *  earlier site in this function, and no read after the site's boundary. */
function classify_donor(
	source: string,
	src_type: Type | undefined,
	tgt_type: Type | undefined,
	skip: { enter: number; exit: number },
	boundary_exit: number,
	loop_ranges: LoopRange[],
	binding: DeclareRecord | undefined,
	walk: Walk,
	param_names: Set<string>,
	moved: Set<string>,
): boolean {
	if (moved.has(source)) return false; // an earlier site in this function already moved it
	if (!src_type?.name || !tgt_type?.name) return false;
	if (src_type.name !== tgt_type.name) return false;
	if (src_type.is_view || src_type.is_array || tgt_type.is_view || tgt_type.is_array) {
		return false;
	}
	if (src_type.is_nullable || tgt_type.is_nullable) return false;
	if (!movable_var_source(source, walk, param_names)) return false;
	if (!last_use_read_ok(source, skip.enter, skip.exit, boundary_exit, loop_ranges, binding, walk)) {
		return false;
	}
	return true;
}

function classify_site(
	site: RawSite,
	walk: Walk,
	param_names: Set<string>,
	func_label: string,
	moved: Set<string>,
): ClassifyHit | undefined {
	if (site.kind === "assign")
		return classify_assign(site.rec, walk, param_names, func_label, moved);
	if (site.kind === "declare") {
		return classify_declare(site.rec, walk, param_names, func_label, moved);
	}
	if (site.kind === "return")
		return classify_return(site.rec, walk, param_names, func_label, moved);
	return classify_call(site.rec, walk, param_names, func_label, moved);
}

function classify_assign(
	assign: AssignmentRecord,
	walk: Walk,
	param_names: Set<string>,
	func_label: string,
	moved: Set<string>,
): ClassifyHit | undefined {
	const node = assign.node;
	if (node.operator) return undefined; // compound: the RHS is a real use
	if (node.swap) return undefined; // transfer-with-revalidation: explicit spellings only
	const left = node.left_value;
	const whole_var = left.node_type === "value";
	if (!whole_var && !is_field_target(left)) return undefined;
	const target = target_text(left);

	if (node.right_value.node_type === "value") {
		// Shape A — bare owned-string variable (`s = t`), the tranche-4 move.
		if (!whole_var) return undefined; // strings keep the whole-variable shape
		const target_value = left as ValueNode;
		const source_node = node.right_value as ValueNode;
		const source = source_node.value;
		if (typeof source !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source)) return undefined;
		if (target === source) return undefined;
		if (source_node.is_moved) return undefined; // already an explicit mv
		if (moved.has(source)) return undefined; // an earlier site already moved it
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

		if (
			!last_use_read_ok(
				source,
				assign.enter,
				assign.exit,
				assign.exit,
				assign.loop_ranges,
				binding,
				walk,
			)
		) {
			return undefined;
		}
		moved.add(source);
		return {
			site: {
				func: func_label,
				target,
				source,
				desc: `${target} = ${source}`,
			},
		};
	}

	// Shape B — `p = q.copy()` (whole variable or field store) where the
	// checker resolved a fresh-value deep copy: when `q` is dead after the
	// site, the deep copy is dead weight and the RHS rewrites to `mv q`
	// (zero field copies).
	const copy = copy_receiver(node.right_value);
	if (!copy) return undefined;
	const source = copy.receiver.value;
	if (whole_var && target === source) return undefined; // `p = p.copy()` reads itself
	const tgt_type = whole_var
		? (left as ValueNode).type
		: (left as AccessNode).access.node_type === "access_field"
			? (left as AccessNode).access.type
			: undefined;
	if (
		!classify_donor(
			source,
			copy.receiver.type,
			tgt_type,
			{ enter: assign.enter, exit: assign.exit },
			assign.exit,
			assign.loop_ranges,
			walk.declares.filter((d) => d.name === source && d.enter < assign.enter).at(-1),
			walk,
			param_names,
			moved,
		)
	) {
		return undefined;
	}
	moved.add(source);
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

/**
 * Declare-site classification: `var u = t` where t is an owned string local
 * never touched (read OR written) after the declare, and `var u = t.copy()`
 * where the copy is a fresh-value deep copy (synthesized struct copy or
 * List/Map/Set library copy) and t is dead after. Together with the
 * assignment classification above this covers both mv-on-last-use shapes
 * per family: plain `s = t` reassignment (value semantics would strdup) and
 * the declare alias (`var u = t`) for strings; the whole-RHS deep-copy
 * sites for structs and containers.
 */
function classify_declare(
	decl: DeclareRecord,
	walk: Walk,
	param_names: Set<string>,
	func_label: string,
	moved: Set<string>,
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
		if (moved.has(source)) return undefined; // an earlier site already moved it
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
		if (
			!last_use_read_ok(
				source,
				decl.enter,
				decl.exit,
				decl.exit,
				decl.loop_ranges ?? [],
				binding,
				walk,
			)
		) {
			return undefined;
		}
		moved.add(source);
		return {
			site: {
				func: func_label,
				target: node.name,
				source,
				desc: `var ${node.name} = ${source}`,
			},
		};
	}

	// Shape B — `var u = t.copy()`, a fresh-value deep copy at the donor's
	// last use: rewrite to `var u = mv t`.
	const copy = copy_receiver(value);
	if (!copy) return undefined;
	const source = copy.receiver.value;
	if (node.swap) return undefined; // transfer-with-revalidation stays explicit
	if (
		!classify_donor(
			source,
			copy.receiver.type,
			node.type,
			{ enter: decl.enter, exit: decl.exit },
			decl.exit,
			decl.loop_ranges ?? [],
			walk.declares.findLast((d) => d.name === source && d.exit < decl.enter),
			walk,
			param_names,
			moved,
		)
	) {
		return undefined;
	}
	moved.add(source);
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

/**
 * Return-site classification: `return t.copy()` where the copy is a
 * fresh-value deep copy and `t` is dead after the return — the callee
 * receives the donor's state and the per-field deep copy drops out. The
 * result type must match the donor's (stamped); view/array/nullable
 * returns keep the copy.
 */
function classify_return(
	ret: ReturnRecord,
	walk: Walk,
	param_names: Set<string>,
	func_label: string,
	moved: Set<string>,
): ClassifyHit | undefined {
	const copy = copy_receiver(ret.node.value ?? undefined);
	if (!copy) return undefined;
	const source = copy.receiver.value;
	const value_node = ret.node.value;
	const ret_type =
		value_node?.node_type === "access"
			? (value_node as AccessNode).access.node_type === "access_func"
				? (value_node as AccessNode).access.type
				: undefined
			: undefined;
	if (
		!classify_donor(
			source,
			copy.receiver.type,
			ret_type,
			{ enter: ret.enter, exit: ret.exit },
			ret.exit,
			ret.loop_ranges,
			walk.declares.findLast((d) => d.name === source && d.exit < ret.enter),
			walk,
			param_names,
			moved,
		)
	) {
		return undefined;
	}
	moved.add(source);
	return {
		site: {
			func: func_label,
			target: "<return>",
			source,
			desc: `return ${source}.copy()`,
		},
		struct_copy: source,
	};
}

/**
 * Call-site classification: an argument whose checker-hoisted
 * `const _param_N = t.copy()` allocation is the donor's last-use copy.
 * The rewrite splices the allocation and stamps the bare `mv t` donor —
 * the exact AST the explicit spelling parses into — so the rewritten
 * argument must obey the checker's own mv rules: the callee parameter is
 * `mv`-declared (mv into a borrow parameter is a check error for the
 * explicit spelling). `skip` is the ALLOCATION's interval (the copy and
 * its receiver read live there, ahead of the call); the boundary is the
 * call's exit, so a sibling argument reading the donor refuses.
 */
function classify_call(
	call: CallRecord,
	walk: Walk,
	param_names: Set<string>,
	func_label: string,
	moved: Set<string>,
): ClassifyHit | undefined {
	const node = call.node;
	for (let i = 0; i < node.params.length; i++) {
		const param = node.params[i];
		if (!param || param.node_type !== "value") continue;
		const temp_name = (param as ValueNode).value;
		if (typeof temp_name !== "string" || !temp_name.startsWith("_param_")) continue;
		// The hoisted allocation: search the enclosing statements' allocation
		// frames (nearest first) for the declare this param names.
		let alloc: DeclareRecord | undefined;
		let alloc_node: DeclarationNode | undefined;
		let allocs: BaseNode[] | undefined;
		let alloc_index = -1;
		for (const frame of call.alloc_frames) {
			const at = frame.findIndex(
				(n) => n.node_type === "declare" && (n as unknown as { name?: string }).name === temp_name,
			);
			if (at !== -1) {
				allocs = frame;
				alloc_index = at;
				alloc_node = frame[at] as DeclarationNode;
				alloc = walk.declares.findLast(
					(d) => d.node === alloc_node || (d.name === temp_name && d.node === alloc_node),
				);
				break;
			}
		}
		if (!alloc_node || !allocs || alloc_index === -1 || !alloc) continue;
		const copy = copy_receiver(alloc_node.value);
		if (!copy) continue;
		const source = copy.receiver.value;
		if (moved.has(source)) continue; // an earlier site already moved it
		// The rewritten spelling must be one the language accepts: the
		// callee's parameter takes ownership.
		const callee_params = node.resolved_function?.params?.filter((p) => !p.is_self_param);
		if (!callee_params?.[i]?.is_moved) continue;
		const binding = walk.declares.findLast((d) => d.name === source && d.exit < alloc.enter);
		if (
			!classify_donor(
				source,
				copy.receiver.type,
				alloc_node.type,
				{ enter: alloc.enter, exit: alloc.exit },
				call.exit,
				call.loop_ranges,
				binding,
				walk,
				param_names,
				moved,
			)
		) {
			continue;
		}
		moved.add(source);
		return {
			site: {
				func: func_label,
				target: call.spell,
				source,
				desc: `${call.spell}(${source}.copy())`,
			},
			param: {
				node,
				record: { index: i, alloc: alloc_node, allocs, alloc_index },
			},
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
	// Checker-hoisted interpolation/argument temps ride as `node.allocations`
	// declare statements (`const _param_N = x.to_string()`) that the block
	// builder emits BEFORE this statement. Their bodies READ the sources they
	// wrap — an interpolation of `own` after an `owns = own` assignment is a
	// real later read, so the hoisted declares must be walked here (at the
	// carrying statement's position) or the mv candidates' last-use test
	// never sees those reads. The frames are also how a call argument's
	// rewrite finds (and splices out) its hoisted `_param_N` copy.
	if (node.allocations?.length) {
		walk.alloc_frames.push(node.allocations);
		for (const alloc of node.allocations) walk_stmt(walk, alloc);
		walk_stmt_inner(walk, node);
		walk.alloc_frames.pop();
		return;
	}
	walk_stmt_inner(walk, node);
}

function walk_stmt_inner(walk: Walk, node: BaseNode): void {
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
		case "return": {
			const ret = node as ReturnNode;
			if (!ret.value) return;
			const loop_ranges = [...walk.loop_stack];
			const enter = ++walk.stamp;
			walk_expr(walk, ret.value);
			const exit = ++walk.stamp;
			// A candidate return: the whole value is a fresh-value `.copy()`
			// (synthesized struct copy or container library copy).
			if (copy_receiver(ret.value)) walk.returns.push({ node: ret, enter, exit, loop_ranges });
			return;
		}
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
				const af = access.access as AccessFunctionCallNode;
				if (af.params.length > 0) {
					// A method call with arguments: a candidate for rewriting a
					// hoisted `_param_N` copy argument into the bare `mv` donor
					// (container stores). The interval brackets the ARGUMENTS —
					// the receiver was read before it.
					const loop_ranges = [...walk.loop_stack];
					const enter = ++walk.stamp;
					for (const p of af.params) walk_expr(walk, p);
					const exit = ++walk.stamp;
					walk.calls.push({
						node: af,
						spell: `${target_text(access.target)}.${af.name}`,
						enter,
						exit,
						loop_ranges,
						alloc_frames: [...walk.alloc_frames],
					});
				}
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
			const fc = node as FunctionCallNode;
			if (fc.params.length === 0) return;
			const loop_ranges = [...walk.loop_stack];
			const enter = ++walk.stamp;
			for (const p of fc.params) walk_expr(walk, p);
			const exit = ++walk.stamp;
			walk.calls.push({
				node: fc,
				spell: fc.name,
				enter,
				exit,
				loop_ranges,
				alloc_frames: [...walk.alloc_frames],
			});
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
