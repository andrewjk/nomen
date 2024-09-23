import AccessFieldNode from "../nodes/AccessFieldNode";
import AccessInvocationNode from "../nodes/AccessInvocationNode";
import AccessNode from "../nodes/AccessNode";
import ArrayValuesNode from "../nodes/ArrayValuesNode";
import BaseNode from "../nodes/BaseNode";
import InvocationNode from "../nodes/InvocationNode";
import OperationNode from "../nodes/OperationNode";
import Type from "../nodes/Type";
import ValueNode from "../nodes/ValueNode";

export default function type_from_value_node(node: BaseNode): Type {
  switch (node.node_type) {
    case "access": {
      return type_from_value_node((node as AccessNode).access);
    }
    case "value": {
      return (node as ValueNode).type;
    }
    case "array": {
      return (node as ArrayValuesNode).type;
    }
    case "invoke": {
      return (node as InvocationNode).type;
    }
    case "ac_field": {
      return (node as AccessFieldNode).type;
    }
    case "ac_invoke": {
      return (node as AccessInvocationNode).type;
    }
    case "op": {
      return (node as OperationNode).type;
    }
  }
  return new Type("");
}
