import type BaseNode from "../../nodes/BaseNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";

/**
 * Given a condition node, check if it's a null check of the form `thing == null`
 * or `thing != null`. Returns the variable name and whether it's an equality check.
 */
export default function get_null_check_var(
	condition: BaseNode,
): { name: string; is_null_check: boolean } | null {
	if (condition.node_type !== "op") return null;
	const op = condition as OperationNode;
	if (op.op !== "==" && op.op !== "!=") return null;

	const left = op.left_value;
	const right = op.right_value;
	const is_eq = op.op === "==";

	if (left.node_type === "value" && right.node_type === "value") {
		const lv = left as ValueNode;
		const rv = right as ValueNode;
		if (rv.value === "null" && lv.type?.is_nullable) {
			return { name: lv.value, is_null_check: is_eq };
		}
		if (lv.value === "null" && rv.type?.is_nullable) {
			return { name: rv.value, is_null_check: is_eq };
		}
	}
	return null;
}
