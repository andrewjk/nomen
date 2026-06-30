import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import { is_class_type } from "./ownership.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * Whether `node` produces a borrowed class reference, and the scope depth the
 * borrow was taken at. Borrows arise from class field access (`p.a`) or from
 * reading a variable that already holds a borrow. Returns undefined when the
 * node does not produce a borrow (owned values, copies of value types, etc.).
 *
 * The returned depth is the scope where the borrow originated; a borrow may not
 * be assigned/returned to a variable declared at a shallower (outer) scope.
 */
export function borrow_depth_of(node: BaseNode, status: CheckStatus): number | undefined {
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const t = type_from_value_node(access, status);
			if (t?.name && is_class_type(t.name, status)) {
				return status.scope_depth;
			}
		}
	}
	if (node.node_type === "value") {
		const decl = status.values.findLast((v) => v.name === (node as ValueNode).value);
		return decl?.borrow_depth;
	}
	return undefined;
}
