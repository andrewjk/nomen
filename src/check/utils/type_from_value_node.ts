import AccessFieldNode from "../../nodes/AccessFieldNode";
import AccessInvocationNode from "../../nodes/AccessInvocationNode";
import AccessNode from "../../nodes/AccessNode";
import ArrayValuesNode from "../../nodes/ArrayValuesNode";
import BaseNode from "../../nodes/BaseNode";
import IfElseNode from "../../nodes/IfElseNode";
import InvocationNode from "../../nodes/InvocationNode";
import OperationNode from "../../nodes/OperationNode";
import RangeNode from "../../nodes/RangeNode";
import Type from "../../nodes/Type";
import ValueNode from "../../nodes/ValueNode";
import type CheckStatus from "../CheckStatus";
import type_from_value from "./type_from_value";

export default function type_from_value_node(node: BaseNode, status: CheckStatus): Type {
  switch (node.node_type) {
    case "value": {
      return type_from_value((node as ValueNode).value, status);
    }
    case "access": {
      return type_from_value_node((node as AccessNode).access, status);
    }
    case "array": {
      const type = (node as ArrayValuesNode).type;
      type.is_array = true;
      return type;
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
    case "if": {
      return (node as IfElseNode).return_type;
    }
    case "op": {
      return (node as OperationNode).type;
    }
    case "range": {
      const type = type_from_value_node((node as RangeNode).left_value!, status);
      type.is_array = true;
      return type;
    }
  }
  return new Type("");
}
