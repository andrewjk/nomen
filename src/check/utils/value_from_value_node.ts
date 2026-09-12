import AccessNode from "../../nodes/AccessNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";

export default function value_from_value_node(node: BaseNode): string {
	switch (node.node_type) {
		case "value": {
			return (node as ValueNode).value;
		}
		case "access": {
			return value_from_value_node((node as AccessNode).target);
		}
		case "index": {
			// `p[i] = v` / `p[i].field = v` — the root is the pointer's base
			// identifier (const-ness of the pointer doesn't block stores
			// THROUGH it, matching the borrow semantics of `ref` targets).
			return value_from_value_node(
				(node as import("../../nodes/IndexNode.ts").default).target as BaseNode,
			);
		}
		case "grouped": {
			// `(expr) = ...` — descend through the parentheses.
			return value_from_value_node(
				(node as import("../../nodes/GroupedNode.ts").default).value as BaseNode,
			);
		}
		case "cast": {
			// `(x as ptr T)[i] = v` — the root is the cast's operand.
			return value_from_value_node(
				(node as import("../../nodes/CastNode.ts").default).value as BaseNode,
			);
		}
	}
	return "?";
}
