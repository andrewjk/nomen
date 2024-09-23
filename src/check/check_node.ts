import AccessNode from "../nodes/AccessNode";
import ArrayValuesNode from "../nodes/ArrayValuesNode";
import AssignmentNode from "../nodes/AssignmentNode";
import BaseNode from "../nodes/BaseNode";
import BreakNode from "../nodes/BreakNode";
import ContinueNode from "../nodes/ContinueNode";
import DeclarationNode from "../nodes/DeclarationNode";
import ForLoopNode from "../nodes/ForLoopNode";
import FunctionNode from "../nodes/FunctionNode";
import IfElseNode from "../nodes/IfElseNode";
import InvocationNode from "../nodes/InvocationNode";
import OperationNode from "../nodes/OperationNode";
import RangeNode from "../nodes/RangeNode";
import ReturnNode from "../nodes/ReturnNode";
import RootNode from "../nodes/RootNode";
import StructNode from "../nodes/StructNode";
import TraitNode from "../nodes/TraitNode";
import ValueNode from "../nodes/ValueNode";
import WhileLoopNode from "../nodes/WhileLoopNode";
import type CheckStatus from "./CheckStatus";
import check_access_node from "./check_access_node";
import check_array_values_node from "./check_array_values_node";
import check_assignment_node from "./check_assignment_node";
import check_block_node from "./check_block_node";
import check_break_or_continue_node from "./check_break_or_continue_node";
import check_declaration_node from "./check_declaration_node";
import check_for_loop_node from "./check_for_loop_node";
import check_function_node from "./check_function_node";
import check_if_else_node from "./check_if_else_node";
import check_invocation_node from "./check_invocation_node";
import check_operation_node from "./check_operation_node";
import check_range_node from "./check_range_node";
import check_return_node from "./check_return_node";
import check_struct_node from "./check_struct_node";
import check_trait_node from "./check_trait_node";
import check_value_node from "./check_value_node";
import check_while_loop_node from "./check_while_loop_node";

export default function check_node(node: BaseNode, status: CheckStatus) {
  switch (node.node_type) {
    case "root": {
      check_block_node(node as RootNode, status);
      break;
    }
    case "struct": {
      check_struct_node(node as StructNode, status);
      break;
    }
    case "trait": {
      check_trait_node(node as TraitNode, status);
      break;
    }
    case "func": {
      check_function_node(node as FunctionNode, status);
      break;
    }
    case "declare": {
      check_declaration_node(node as DeclarationNode, status);
      break;
    }
    case "assign": {
      check_assignment_node(node as AssignmentNode, status);
      break;
    }
    case "invoke": {
      check_invocation_node(node as InvocationNode, status);
      break;
    }
    case "access": {
      check_access_node(node as AccessNode, status);
      break;
    }
    case "if": {
      check_if_else_node(node as IfElseNode, status);
      break;
    }
    case "for": {
      check_for_loop_node(node as ForLoopNode, status);
      break;
    }
    case "while": {
      check_while_loop_node(node as WhileLoopNode, status);
      break;
    }
    case "op": {
      check_operation_node(node as OperationNode, status);
      break;
    }
    case "array": {
      check_array_values_node(node as ArrayValuesNode, status);
      break;
    }
    case "range": {
      check_range_node(node as RangeNode, status);
      break;
    }
    case "value": {
      check_value_node(node as ValueNode, status);
      break;
    }
    case "break": {
      check_break_or_continue_node(node as BreakNode, status);
      break;
    }
    case "continue": {
      check_break_or_continue_node(node as ContinueNode, status);
      break;
    }
    case "panic":
    case "todo": {
      // todo
      break;
    }
    case "return": {
      check_return_node(node as ReturnNode, status);
      break;
    }
    default: {
      status.errors.push({
        message: `Unknown node type: ${node.node_type}`,
        start: node.start,
      });
      break;
    }
  }
}
