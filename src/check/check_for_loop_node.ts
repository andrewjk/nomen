import add_error from "../add_error.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
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

		if (for_loop.item) {
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
				declaration: "var",
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
}

function evaluate_range_bound_value(node: BaseNode, status: CheckStatus): number | undefined {
	const val = evaluate_numeric_or_bool(node, status);
	if (typeof val === "number") return val;
	return undefined;
}
