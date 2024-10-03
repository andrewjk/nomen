import AccessFieldNode from "../../nodes/AccessFieldNode";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode";
import AccessNode from "../../nodes/AccessNode";
import ArrayValuesNode from "../../nodes/ArrayValuesNode";
import BaseNode from "../../nodes/BaseNode";
import FunctionCallNode from "../../nodes/FunctionCallNode";
import GroupedNode from "../../nodes/GroupedNode";
import OperationNode from "../../nodes/OperationNode";
import Type from "../../nodes/Type";
import ValueNode from "../../nodes/ValueNode";

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
    case "func_call": {
      return (node as FunctionCallNode).type;
    }
    case "access_field": {
      return (node as AccessFieldNode).type;
    }
    case "access_func": {
      return (node as AccessFunctionCallNode).type;
    }
    case "grouped": {
      return type_from_value_node((node as GroupedNode).value);
    }
    case "op": {
      return (node as OperationNode).type;
    }
  }
  return new Type("");
}
