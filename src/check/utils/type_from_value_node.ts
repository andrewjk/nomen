import AccessFieldNode from "../../nodes/AccessFieldNode";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode";
import AccessIndexNode from "../../nodes/AccessIndexNode";
import AccessNode from "../../nodes/AccessNode";
import ArrayValuesNode from "../../nodes/ArrayValuesNode";
import BaseNode from "../../nodes/BaseNode";
import FunctionCallNode from "../../nodes/FunctionCallNode";
import GroupedNode from "../../nodes/GroupedNode";
import IfElseNode from "../../nodes/IfElseNode";
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
    case "func_call": {
      return (node as FunctionCallNode).type;
    }
    case "access_field": {
      return (node as AccessFieldNode).type;
    }
    case "access_func": {
      return (node as AccessFunctionCallNode).type;
    }
    case "access_index": {
      return (node as AccessIndexNode).type;
    }
    case "if": {
      return (node as IfElseNode).return_type;
    }
    case "grouped": {
      return type_from_value_node((node as GroupedNode).value, status);
    }
    case "op": {
      return (node as OperationNode).type;
    }
    case "range": {
      return (node as RangeNode).type;
    }
  }
  return new Type("");
}
