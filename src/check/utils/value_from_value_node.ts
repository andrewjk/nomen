import AccessFieldNode from "../../nodes/AccessFieldNode";
import AccessNode from "../../nodes/AccessNode";
import BaseNode from "../../nodes/BaseNode";
import ValueNode from "../../nodes/ValueNode";

export default function value_from_value_node(node: BaseNode): string {
  switch (node.node_type) {
    case "value": {
      return (node as ValueNode).value;
    }
    case "access": {
      return value_from_value_node((node as AccessNode).access);
    }
    case "ac_field": {
      return (node as AccessFieldNode).name;
    }
  }
  return "?";
}
