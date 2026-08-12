import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import clone_node from "../nodes/clone_node.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { persist_invalidated } from "./utils/borrow.ts";
import clone_status from "./utils/clone_status.ts";
import { evaluate_numeric_or_bool } from "./utils/evaluate_const_condition.ts";
import { expr_to_string } from "./utils/flow_bounds.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

function has_trait(type_name: string, trait_name: string, status: CheckStatus): boolean {
	const struct = status.structs.find((s) => s.name === type_name);
	if (!struct) return false;
	return struct.traits.includes(trait_name);
}

export default function check_for_loop_node(for_loop: ForLoopNode, status: CheckStatus) {
	// Desugar array value-iteration:
	//   for x of arr        (arr is an Array<T>)
	// becomes
	//   for __idx of 0..arr.length { var x = arr.at(__idx) }
	// so the element is obtained through `.at` (whose `index < self.length`
	// constraint is satisfied by the loop bounds) and the body sees `x` as a
	// value of type T. Only desugar simple (value) list expressions so the
	// list isn't evaluated more than once; richer expressions fall through to
	// the array path below.
	if (
		for_loop.list &&
		!(for_loop.list instanceof RangeNode) &&
		for_loop.list.node_type === "value"
	) {
		// type_from_value_node is read-only (no error side effects); the list is
		// checked normally below (or by the recursive call after desugaring).
		const list_type = type_from_value_node(for_loop.list, status);
		const enumerable = list_type.name ? has_trait(list_type.name, "Enumerable", status) : false;
		// Only desugar when the monomorphized Array struct (providing `.at`) is
		// in scope — otherwise the generated `arr.at(i)` would be unresolved
		// (e.g. bare parse without the System library) — AND when the list's
		// `.at`/`.length` dispatch is well-defined: a heap `Array<T>`
		// (`is_array_heap`, struct methods) or a stack array with a compile-time
		// `length` (raw-index `.at`, constant `.length`). A raw `int[]` PARAM
		// (plain `is_array`, no length, no heap flag) is a bare element pointer
		// — `.length`/`.at` on it are garbage — so it must NOT desugar; the
		// build's raw-iteration path uses the caller's stamped compile-time
		// length instead.
		const has_at =
			list_type.name !== undefined &&
			!!status.structs.find(
				(s) => s.name === "Array_" + list_type.name && s.functions.some((f) => f.name === "at"),
			);
		if (
			list_type.is_array &&
			!enumerable &&
			has_at &&
			(list_type.is_array_heap || !!list_type.length)
		) {
			desugar_array_for_loop(for_loop, list_type);
			for_loop.item_is_ref = false;
			check_for_loop_node(for_loop, status);
			return;
		}
	}

	let for_status = clone_status(status);

	if (for_loop.list) {
		check_node(for_loop.list, for_status);

		const list_type = type_from_value_node(for_loop.list, for_status);
		const is_enumerable = list_type.name
			? has_trait(list_type.name, "Enumerable", for_status)
			: false;

		if (!list_type.is_array && !is_enumerable && list_type.name) {
			add_error(
				for_status,
				`For loop list must be an array or Enumerable, not ${list_type.name}`,
				for_loop.list.start,
			);
		}

		// `for ref x of arr` writes each element back via arr[idx] = x, which
		// requires a mutable array. Reject it on a const binding.
		if (for_loop.item_is_ref && list_type.is_array && for_loop.list.node_type === "value") {
			const list_name = (for_loop.list as ValueNode).value;
			const list_value = for_status.values.find((v) => v.name === list_name);
			if (list_value && list_value.declaration !== "var") {
				add_error(
					for_status,
					`'ref' iteration requires a 'var' array, but '${list_name}' is const`,
					for_loop.list.start,
				);
			}
		}

		if (for_loop.item) {
			if (for_loop.item_is_ref && (for_loop.list instanceof RangeNode || is_enumerable)) {
				add_error(
					for_status,
					`'ref' is only valid for array element iteration (for ref x of arr), not ranges or Enumerable types`,
					for_loop.item.start,
				);
			}
			if (is_enumerable) {
				// Enumerable types iterate over indices; item type is int
				for_loop.item.type = new Type("int", true);
			} else {
				for_loop.item.type = new Type(list_type.name);
			}

			let range_lower: number | undefined;
			let range_upper: number | undefined;

			if (for_loop.list instanceof RangeNode) {
				const range = for_loop.list;
				if (range.left_value.node_type === "value") {
					range_lower = parseInt((range.left_value as ValueNode).value, 10);
					if (isNaN(range_lower)) range_lower = undefined;
				}
				// Evaluate right bound: literal or .length access
				range_upper = evaluate_range_bound_value(range.right_value, for_status);
			}

			// If the upper bound isn't a compile-time number, track the expression
			// so flow-sensitive bounds checking can use it (e.g. 0..list.length)
			let upper_bound_expr: string | undefined;
			if (for_loop.list instanceof RangeNode && range_upper === undefined) {
				upper_bound_expr = expr_to_string((for_loop.list as RangeNode).right_value, for_status);
			}

			// For Enumerable types, synthesize a range expression 0..container.length()
			if (is_enumerable) {
				range_lower = 0;
				// Track the length expression for bounds checking
				upper_bound_expr = expr_to_string(for_loop.list, for_status);
				if (upper_bound_expr) {
					upper_bound_expr = upper_bound_expr + ".length";
				}
			}

			for_status.values.push({
				declaration: for_loop.item_is_ref ? "var" : "const",
				name: for_loop.item.value,
				type: for_loop.item.type,
				is_set: true,
				range_lower,
				range_upper,
				upper_bound_exprs: upper_bound_expr ? [upper_bound_expr] : undefined,
				upper_bound_expr,
			});
		}
	}

	check_block_node(for_loop, for_status);

	if (for_loop.update) {
		check_node(for_loop.update, for_status);
	}

	// The body may have executed before the post-loop code, so invalidations
	// performed in it persist into the enclosing scope.
	persist_invalidated(status, for_status);
}

/**
 * Rewrite `for x of arr` in place into `for __idx of 0..arr.length { x = arr.at(__idx) }`.
 *
 * By default `x` is const (read-only). For `for ref x of arr` the desugaring is
 * copy-out / mutate / copy-back: `var x = arr.at(__idx)` is prepended and
 * `arr.set(__idx, x)` is appended, with the write-back duplicated before every
 * break/continue so mutations persist on all exit paths. (The write-back is
 * skipped on `return`, matching Rust's copy semantics.)
 */
function desugar_array_for_loop(for_loop: ForLoopNode, array_type: Type) {
	const list = for_loop.list;
	const start = list.start;
	const original_item = for_loop.item;
	const idx_name = `__for_idx_${original_item.value}`;
	const is_ref = !!for_loop.item_is_ref;

	// The loop variable becomes the hidden index.
	for_loop.item = new ValueNode(original_item.start, idx_name);

	// list := 0 .. <bound>, where <bound> is the array's compile-time length
	// when known (e.g. `Array(1,2,3)`), otherwise `arr.length` (dynamic arrays
	// such as those from `Array.with`). A heap `Array<T>` (is_array_heap) whose
	// type carries a STAMPED compile-time length (e.g. the literal passed to a
	// param at a call site) must still use the RUNTIME `arr.length` — the
	// stamped length is per-call and would be wrong for a different-length
	// argument.
	const zero = new ValueNode(start, "0");
	const bound =
		array_type.is_array_heap || !array_type.length
			? new AccessNode(start, clone_node(list), new AccessFieldNode(start, "length"))
			: clone_node(array_type.length);
	for_loop.list = new RangeNode(start, zero, bound);

	// Prepend to the body: <var|const> <original_item> = arr.at(__idx)
	const at_call = new AccessFunctionCallNode(start, "at", new Type(""), [
		new ValueNode(start, idx_name),
	]);
	const at_access = new AccessNode(start, clone_node(list), at_call);
	const decl = new DeclarationNode(
		original_item.start,
		"private",
		is_ref ? "var" : "const",
		original_item.value,
		new Type(array_type.name),
		at_access,
	);
	decl.is_loop_iterator = true;
	for_loop.statements.unshift(decl);

	// For ref iteration, append the write-back: arr.set(__idx, x), and insert a
	// copy before every break/continue so mutations aren't lost on early exit.
	if (is_ref) {
		const make_writeback = (): BaseNode => {
			const set_call = new AccessFunctionCallNode(start, "set", new Type(""), [
				new ValueNode(start, idx_name),
				new ValueNode(start, original_item.value),
			]);
			return new AccessNode(start, clone_node(list), set_call);
		};
		insert_writebacks(for_loop.statements, make_writeback);
		for_loop.statements.push(make_writeback());
	}
}

/**
 * Walk a statement array and insert a write-back node before every break /
 * continue that belongs to the current loop. Nested for/while loops and nested
 * function bodies are not descended into (their exits belong to them).
 */
function insert_writebacks(statements: BaseNode[], make_writeback: () => BaseNode): void {
	for (let i = statements.length - 1; i >= 0; i--) {
		const stmt = statements[i];
		if (stmt.node_type === "break" || stmt.node_type === "continue") {
			statements.splice(i, 0, make_writeback());
			continue;
		}
		// Don't rewrite exits belonging to nested loops or function bodies.
		if (stmt.node_type === "for" || stmt.node_type === "while" || stmt.node_type === "func")
			continue;
		// Recurse into child statement arrays (if-branches, switch arms, etc.).
		for (const key of Object.keys(stmt)) {
			if (key === "parent" || key === "scope") continue;
			const val = (stmt as unknown as Record<string, unknown>)[key];
			if (Array.isArray(val)) {
				insert_writebacks(val as BaseNode[], make_writeback);
			}
		}
	}
}

function evaluate_range_bound_value(node: BaseNode, status: CheckStatus): number | undefined {
	const val = evaluate_numeric_or_bool(node, status);
	if (typeof val === "number") return val;
	return undefined;
}
