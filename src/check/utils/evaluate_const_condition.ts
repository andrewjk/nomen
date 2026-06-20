import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
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
	// Check if left side is a variable with range bounds (from for-loop)
	if (op.left_value.node_type === "value") {
		const vn = op.left_value as ValueNode;
		const decl = status.values.findLast((v) => v.name === vn.value);
		if (decl && (decl.range_lower !== undefined || decl.range_upper !== undefined)) {
			const right_val = evaluate_numeric_or_bool(op.right_value, status);
			if (right_val !== undefined && typeof right_val === "number") {
				return evaluate_range_bound(decl, op.op, right_val);
			}
		}
	}

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

	/**
	 * Evaluate a comparison against a variable with range bounds (from a for-loop).
	 * The range is [range_lower, range_upper) — lower inclusive, upper exclusive.
	 */
	function evaluate_range_bound(
		decl: { range_lower?: number; range_upper?: number },
		op: string,
		right_val: number,
	): boolean | undefined {
		switch (op) {
			case ">=":
				return decl.range_lower !== undefined ? decl.range_lower >= right_val : undefined;
			case "<":
				// i < X: since i < range_upper (exclusive), need range_upper <= X
				return decl.range_upper !== undefined ? decl.range_upper <= right_val : undefined;
			case ">":
				return decl.range_lower !== undefined ? decl.range_lower > right_val : undefined;
			case "<=":
				// i <= X: max value is range_upper - 1, need range_upper - 1 <= X
				return decl.range_upper !== undefined ? decl.range_upper - 1 <= right_val : undefined;
			case "==":
				if (
					decl.range_lower !== undefined &&
					decl.range_upper !== undefined &&
					decl.range_lower === decl.range_upper - 1
				) {
					return decl.range_lower === right_val;
				}
				return undefined;
			case "!=":
				if (
					decl.range_lower !== undefined &&
					decl.range_upper !== undefined &&
					decl.range_lower === decl.range_upper - 1
				) {
					return decl.range_lower !== right_val;
				}
				return undefined;
			default:
				return undefined;
		}
	}
}

/**
 * Evaluate a node to a compile-time constant value.
 */
export function evaluate_numeric_or_bool(
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

	// Handle property access, e.g. source.length on an array
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const field = access.access as AccessFieldNode;
			if (field.name === "length") {
				// Evaluate the target and check if it's an array with a known length
				const target = evaluate_numeric_or_bool(access.target, status);
				if (target !== undefined) return target;
				// Look up the type to find array length
				if (access.target.node_type === "value") {
					const vn = access.target as ValueNode;
					const decl = status.values.findLast((v) => v.name === vn.value);
					if (decl?.type?.length) {
						const len_node = decl.type.length as ValueNode;
						const len = parseInt(len_node.value, 10);
						if (!isNaN(len)) return len;
					}
				}
			}
		}
	}

	// Handle nested operations (e.g. i >= 0 inside x && y)
	if (node.node_type === "op") {
		const op_node = node as OperationNode;
		// Arithmetic operations: resolve to a numeric value
		if (op_node.op === "+" || op_node.op === "-" || op_node.op === "*" || op_node.op === "/") {
			const left = evaluate_numeric_or_bool(op_node.left_value, status);
			const right = evaluate_numeric_or_bool(op_node.right_value, status);
			if (typeof left === "number" && typeof right === "number") {
				switch (op_node.op) {
					case "+":
						return left + right;
					case "-":
						return left - right;
					case "*":
						return left * right;
					case "/":
						return right !== 0 ? left / right : undefined;
				}
			}
			return undefined;
		}
		return evaluate_const_condition(op_node, status);
	}

	return undefined;
}
