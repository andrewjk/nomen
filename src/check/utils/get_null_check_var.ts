import type BaseNode from "../../nodes/BaseNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import { expr_to_string } from "./flow_bounds.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * Given a condition node, check if it's a null check of the form `thing == null`
 * or `thing != null`. Returns the path (a variable name, or a dotted access
 * path such as `o.inner`) and whether it's an equality check.
 */
export default function get_null_check_var(
	condition: BaseNode,
	status: CheckStatus,
): { name: string; is_null_check: boolean } | null {
	if (condition.node_type !== "op") return null;
	const op = condition as OperationNode;
	if (op.op !== "==" && op.op !== "!=") return null;

	const left = op.left_value;
	const right = op.right_value;
	const is_eq = op.op === "==";

	const path_of = (node: BaseNode): string | undefined => {
		if (node.node_type === "value") return (node as ValueNode).value;
		// A dotted base (`o.inner != null`, `box.next != null`): serialize to
		// the same canonical path the access-null check uses.
		if (node.node_type === "access") return expr_to_string(node);
		return undefined;
	};
	// The access node itself carries no `.type`; the resolved type lives on
	// its inner access field. `type_from_value_node` unwraps it (and resolves
	// a nullable variable's declared type).
	const type_of = (node: BaseNode) => type_from_value_node(node, status);

	if (right.node_type === "value" && (right as ValueNode).value === "null") {
		const path = path_of(left);
		if (path && type_of(left)?.is_nullable) return { name: path, is_null_check: is_eq };
	}
	if (left.node_type === "value" && (left as ValueNode).value === "null") {
		const path = path_of(right);
		if (path && type_of(right)?.is_nullable) return { name: path, is_null_check: is_eq };
	}
	return null;
}
