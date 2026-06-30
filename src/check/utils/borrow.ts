import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import { is_class_type } from "./ownership.ts";
import type_from_value_node from "./type_from_value_node.ts";
import value_from_value_node from "./value_from_value_node.ts";

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

/**
 * The ultimate owner variable a child-group borrow is rooted in, or undefined
 * for owned values. Mirrors `borrow_depth_of`'s classification:
 *  - class field access (`p.a`) → owner is `p` (or p's own owner, transitively);
 *  - instance method returning a class (`list.pop()`) → owner is the receiver
 *    (or its owner, transitively);
 *  - a variable holding a borrow → that variable's owner.
 *
 * Constructors / static calls produce owned values (undefined). This is the
 * reverse index that `borrow_depth` lacks: it records *which* owner a borrow
 * depends on, so the borrow can be invalidated when that owner is mutated.
 */
export function borrow_owner_of(node: BaseNode, status: CheckStatus): string | undefined {
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const t = type_from_value_node(access, status);
			if (t?.name && is_class_type(t.name, status)) {
				return ultimate_owner(access.target, status);
			}
		} else if (access.access.node_type === "access_func") {
			const t = type_from_value_node(access, status);
			if (t?.name && is_class_type(t.name, status)) {
				if (access.target.node_type === "value") {
					const recv = status.values.findLast((v) => v.name === (access.target as ValueNode).value);
					if (recv) {
						// A static call (receiver is a type name, not a variable)
						// returns undefined above; only a tracked receiver borrows.
						return recv.borrowed_from ?? recv.name;
					}
					return undefined;
				}
				return undefined;
			}
		}
	}
	if (node.node_type === "value") {
		const decl = status.values.findLast((v) => v.name === (node as ValueNode).value);
		return decl?.borrowed_from;
	}
	return undefined;
}

/** Resolve an access target down to its ultimate owning variable name. */
function ultimate_owner(target: BaseNode, status: CheckStatus): string | undefined {
	if (target.node_type === "value") {
		const name = (target as ValueNode).value;
		const decl = status.values.findLast((v) => v.name === name);
		return decl?.borrowed_from ?? name;
	}
	return value_from_value_node(target) ?? undefined;
}

/**
 * Mark every live child-group borrow rooted at `owner` as invalidated, because
 * a `ref self` / `var self` call on (or owning-field assignment to) `owner` may
 * free or displace the contents those borrows point into. Reading an
 * invalidated borrow is rejected later in check_value_node.
 */
export function invalidate_borrows_of(status: CheckStatus, owner: string) {
	for (const v of status.values) {
		if (v.borrowed_from === owner) {
			v.borrow_invalidated = true;
		}
	}
}
