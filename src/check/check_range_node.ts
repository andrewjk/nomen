import OperationNode from "../nodes/OperationNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_range_node(range: RangeNode, status: CheckStatus): boolean {
	let result = check_node(range.left_value, status) && check_node(range.right_value, status);
	if (!result) {
		return false;
	}

	check_type_and_value_match(
		type_from_value_node(range.left_value, status),
		type_from_value_node(range.right_value, status),
		value_from_value_node(range.right_value),
		status,
		range.right_value.start,
		"range",
	);

	// Set the range type
	const left_type = type_from_value_node(range.left_value, status);
	range.type = new Type(left_type.name);
	range.type.is_array = true;

	// Compute length: right - left (or right - left + 1 for inclusive)
	// For literal values, compute statically
	const left_val = get_literal_value(range.left_value);
	const right_val = get_literal_value(range.right_value);
	if (left_val !== undefined && right_val !== undefined) {
		const length = range.inclusive ? right_val - left_val + 1 : right_val - left_val;
		range.type.length = new ValueNode(-1, length.toString(), new Type("int", true));
	} else {
		// Try to evaluate constant expressions
		const left_expr_val = evaluate_expression(range.left_value);
		const right_expr_val = evaluate_expression(range.right_value);
		if (left_expr_val !== undefined && right_expr_val !== undefined) {
			const length = range.inclusive
				? right_expr_val - left_expr_val + 1
				: right_expr_val - left_expr_val;
			range.type.length = new ValueNode(-1, length.toString(), new Type("int", true));
		} else {
			// For non-constant expressions, create an operation node for the length
			const diff = new OperationNode(
				range.right_value.start,
				"-",
				range.right_value,
				range.left_value,
				new Type("int"),
			);
			if (range.inclusive) {
				range.type.length = new OperationNode(
					range.right_value.start,
					"+",
					diff,
					new ValueNode(-1, "1", new Type("int", true)),
					new Type("int"),
				);
			} else {
				range.type.length = diff;
			}
		}
	}

	return true;
}

function get_literal_value(node: any): number | undefined {
	if (node.node_type === "value") {
		const n = parseInt((node as ValueNode).value);
		if (!isNaN(n)) return n;
	}
	if (node.node_type === "grouped") {
		return get_literal_value((node as any).value);
	}
	return undefined;
}

function evaluate_expression(node: any): number | undefined {
	if (node.node_type === "value") {
		const n = parseInt((node as ValueNode).value);
		if (!isNaN(n)) return n;
	}
	if (node.node_type === "grouped") {
		return evaluate_expression((node as any).value);
	}
	if (node.node_type === "op") {
		const op = node as OperationNode;
		const left = evaluate_expression(op.left_value);
		const right = evaluate_expression(op.right_value);
		if (left !== undefined && right !== undefined) {
			switch (op.op) {
				case "+":
					return left + right;
				case "-":
					return left - right;
				case "*":
					return left * right;
				case "/":
					return Math.floor(left / right);
			}
		}
	}
	return undefined;
}
