import OperationNode from "../../nodes/OperationNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";

/**
 * Try to evaluate a condition at compile time.
 * Returns `true` if always true, `false` if always false, `undefined` if unknown.
 */
export default function evaluate_const_condition(
	node: import("../../nodes/BaseNode.ts").default,
	status: CheckStatus,
): boolean | undefined {
	if (node.node_type === "value") {
		return evaluate_value(node as ValueNode, status);
	}

	if (node.node_type === "op") {
		return evaluate_operation(node as OperationNode, status);
	}

	return undefined;
}

function evaluate_value(vn: ValueNode, status: CheckStatus): boolean | undefined {
	if (vn.value === "true") return true;
	if (vn.value === "false") return false;

	// Look up const variable
	const decl = status.values.findLast((v) => v.name === vn.value);
	if (decl?.const_value !== undefined && typeof decl.const_value === "boolean") {
		return decl.const_value;
	}

	return undefined;
}

function evaluate_operation(op: OperationNode, status: CheckStatus): boolean | undefined {
	const left = evaluate_numeric_or_bool(op.left_value, status);
	const right = evaluate_numeric_or_bool(op.right_value, status);

	if (left === undefined || right === undefined) return undefined;

	switch (op.op) {
		case "<":
			return (left as number) < (right as number);
		case ">":
			return (left as number) > (right as number);
		case "<=":
			return (left as number) <= (right as number);
		case ">=":
			return (left as number) >= (right as number);
		case "==":
			return left === right;
		case "!=":
			return left !== right;
		case "&&":
			return Boolean(left) && Boolean(right);
		case "||":
			return Boolean(left) || Boolean(right);
		default:
			return undefined;
	}
}

/**
 * Evaluate a node to a compile-time constant value.
 */
function evaluate_numeric_or_bool(
	node: import("../../nodes/BaseNode.ts").default,
	status: CheckStatus,
): number | boolean | string | undefined {
	if (node.node_type === "value") {
		const vn = node as ValueNode;
		if (vn.value === "true") return true;
		if (vn.value === "false") return false;
		if (/^[+-]?\d+$/.test(vn.value)) return parseInt(vn.value, 10);
		if (/^[+-]?\d+\.\d+$/.test(vn.value)) return parseFloat(vn.value);

		// Look up const variable
		const decl = status.values.findLast((v) => v.name === vn.value);
		return decl?.const_value;
	}

	// Could extend to handle arithmetic operations (+, -, *, /) in the future
	return undefined;
}
