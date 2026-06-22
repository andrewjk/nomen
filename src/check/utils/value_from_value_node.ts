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
	}
	return "?";
}
