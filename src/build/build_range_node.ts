import GroupedNode from "../nodes/GroupedNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_range_node(node: RangeNode, status: BuildStatus) {
	const start = evaluate_constant(node.left_value);
	const end = evaluate_constant(node.right_value);

	if (start !== undefined && end !== undefined) {
		// Static bounds - generate array literal
		const actual_end = end;
		status.code += `{${[...Array(actual_end - start).keys()].map((value) => start + value).join(", ")}}`;
	} else {
		// Dynamic bounds - generate a compound literal with the range expressions
		// This is a fallback that may not work in all contexts, but prevents crashes
		status.code += `{`;
		build_node(node.left_value, status);
		status.code += `..`;
		build_node(node.right_value, status);
		status.code += `}`;
	}
}

function evaluate_constant(node: any): number | undefined {
	if (node.node_type === "value") {
		const n = parseInt((node as ValueNode).value);
		if (!isNaN(n)) return n;
	}
	if (node.node_type === "grouped") {
		return evaluate_constant((node as GroupedNode).value);
	}
	if (node.node_type === "op") {
		const op = node as OperationNode;
		const left = evaluate_constant(op.left_value);
		const right = evaluate_constant(op.right_value);
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
