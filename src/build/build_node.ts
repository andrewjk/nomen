import AccessNode from "../nodes/AccessNode";
import ArrayValuesNode from "../nodes/ArrayValuesNode";
import AssignmentNode from "../nodes/AssignmentNode";
import BaseNode from "../nodes/BaseNode";
import BreakNode from "../nodes/BreakNode";
import ContinueNode from "../nodes/ContinueNode";
import DeclarationNode from "../nodes/DeclarationNode";
import ForLoopNode from "../nodes/ForLoopNode";
import FunctionCallNode from "../nodes/FunctionCallNode";
import FunctionNode from "../nodes/FunctionNode";
import GroupedNode from "../nodes/GroupedNode";
import IfElseNode from "../nodes/IfElseNode";
import OperationNode from "../nodes/OperationNode";
import PanicNode from "../nodes/PanicNode";
import RangeNode from "../nodes/RangeNode";
import RawNode from "../nodes/RawNode";
import ReturnNode from "../nodes/ReturnNode";
import RootNode from "../nodes/RootNode";
import StructNode from "../nodes/StructNode";
import TodoNode from "../nodes/TodoNode";
import TraitNode from "../nodes/TraitNode";
import ValueNode from "../nodes/ValueNode";
import WhileLoopNode from "../nodes/WhileLoopNode";
import type BuildStatus from "./BuildStatus";
import build_access_node from "./build_access_node";
import build_array_values_node from "./build_array_values_node";
import build_assignment_node from "./build_assignment_node";
import build_break_node from "./build_break_node";
import build_continue_node from "./build_continue_node";
import build_declaration_node from "./build_declaration_node";
import build_for_loop_node from "./build_for_loop_node";
import build_function_call_node from "./build_function_call_node";
import build_function_node from "./build_function_node";
import build_if_else_node from "./build_if_else_node";
import build_operation_node from "./build_operation_node";
import build_panic_node from "./build_panic_node";
import build_range_node from "./build_range_node";
import build_raw_node from "./build_raw_node";
import build_return_node from "./build_return_node";
import build_root_node from "./build_root_node";
import build_struct_node from "./build_struct_node";
import build_todo_node from "./build_todo_node";
import build_trait_node from "./build_trait_node";
import build_value_node from "./build_value_node";
import build_while_loop_node from "./build_while_loop_node";

export default function build_node(node: BaseNode, status: BuildStatus, with_semicolon = false) {
  switch (node.node_type) {
    case "root": {
      build_root_node(node as RootNode, status);
      break;
    }
    case "declare": {
      build_declaration_node(node as DeclarationNode, status);
      break;
    }
    case "assign": {
      build_assignment_node(node as AssignmentNode, status);
      break;
    }
    case "struct": {
      build_struct_node(node as StructNode, status);
      break;
    }
    case "trait": {
      build_trait_node(node as TraitNode, status);
      break;
    }
    case "func": {
      build_function_node(node as FunctionNode, status);
      break;
    }
    case "func_call": {
      build_function_call_node(node as FunctionCallNode, status);
      break;
    }
    case "access": {
      build_access_node(node as AccessNode, status);
      break;
    }
    case "grouped": {
      status.code += "(";
      build_node((node as GroupedNode).value, status);
      status.code += ")";
      break;
    }
    case "op": {
      build_operation_node(node as OperationNode, status);
      break;
    }
    case "if": {
      build_if_else_node(node as IfElseNode, status);
      with_semicolon = false;
      break;
    }
    case "for": {
      build_for_loop_node(node as ForLoopNode, status);
      with_semicolon = false;
      break;
    }
    case "while": {
      build_while_loop_node(node as WhileLoopNode, status);
      with_semicolon = false;
      break;
    }
    case "break": {
      build_break_node(node as BreakNode, status);
      break;
    }
    case "continue": {
      build_continue_node(node as ContinueNode, status);
      break;
    }
    case "panic": {
      build_panic_node(node as PanicNode, status);
      with_semicolon = false;
      break;
    }
    case "todo": {
      build_todo_node(node as TodoNode, status);
      with_semicolon = false;
      break;
    }
    case "return": {
      build_return_node(node as ReturnNode, status);
      break;
    }
    case "value": {
      build_value_node(node as ValueNode, status);
      break;
    }
    case "array": {
      build_array_values_node(node as ArrayValuesNode, status);
      break;
    }
    case "range": {
      build_range_node(node as RangeNode, status);
      break;
    }
    case "raw": {
      build_raw_node(node as RawNode, status);
      with_semicolon = false;
      break;
    }
    default: {
      throw Error("Invalid node: " + node.node_type);
    }
  }

  if (with_semicolon) {
    // But not if it was a declaration with an if statement etc
    if (!status.code.endsWith("}\n")) {
      status.code += ";\n";
    }
  }
}
