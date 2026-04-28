import type BuildStatus from "../build/BuildStatus.ts";
import GroupedNode from "../nodes/GroupedNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import ValueNode from "../nodes/ValueNode.ts";

export default function build_range_node(node: RangeNode, status: BuildStatus) {
	const start = evaluate_constant(node.left_value);
	const end = evaluate_constant(node.right_value);

	if (start !== undefined && end !== undefined) {
		const actual_end = end + (node.inclusive ? 1 : 0);
		status.code += `${[...Array(actual_end - start).keys()].map((value) => start + value).join(", ")}`;
	} else {
		// Dynamic bounds - not supported for static array generation
		status.code += `/* dynamic range */`;
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
