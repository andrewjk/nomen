import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import { is_class_type } from "./ownership.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * The scope depth a value's lifetime is rooted at, when the value is a borrow
 * whose validity depends on some owner. Returns undefined for owned values.
 *
 * Borrows arise from:
 *  - class field access (`p.a`) — borrow of `p`, taken in the current scope;
 *  - an instance method call returning a class (`list.pop()`, `arr.first()`)
 *    — borrow of the receiver, rooted at the receiver's lifetime;
 *  - a variable that already holds one of the above.
 *
 * Constructors and static factories (`Box(1)`, `Array.with(...)`) produce owned
 * values (not borrows). A borrow may not be assigned/returned to a variable
 * declared at a shallower (outer) scope than its root depth.
 */
export function borrow_depth_of(node: BaseNode, status: CheckStatus): number | undefined {
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const t = type_from_value_node(access, status);
			if (t?.name && is_class_type(t.name, status)) {
				return status.scope_depth;
			}
		} else if (access.access.node_type === "access_func") {
			const t = type_from_value_node(access, status);
			if (t?.name && is_class_type(t.name, status)) {
				// Instance method returning a class borrows from its receiver.
				// Static calls (receiver is a type name, not a variable in
				// scope) and constructors produce owned values — not borrows.
				if (access.target.node_type === "value") {
					const recv = status.values.findLast((v) => v.name === (access.target as ValueNode).value);
					if (recv) {
						return recv.borrow_depth ?? recv.decl_depth ?? status.scope_depth;
					}
					return undefined;
				}
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
