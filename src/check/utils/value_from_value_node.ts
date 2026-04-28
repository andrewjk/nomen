import AccessNode from "../../nodes/AccessNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";

export default function value_from_value_node(node: BaseNode): string {
	switch (node.node_type) {
		case "value": {
			return (node as ValueNode).value;
		}
		case "access": {
			//const access_field = (node as AccessNode).access;
			//if (access_field.node_type === "access_index") {
			return value_from_value_node((node as AccessNode).target);
			//} else {
			//return value_from_value_node(access_field);
			//}
		}
		//case "access_field": {
		//  // TODO: This might be wrong
		//  return (node as AccessFieldNode).name;
		//}
		//case "access_index": {
		//  // TODO: This might be wrong
		//  return "index";
		//}
	}
	return "?";
}
