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
import RangeNode from "../nodes/RangeNode";
import ReturnNode from "../nodes/ReturnNode";
import RootNode from "../nodes/RootNode";
import StructNode from "../nodes/StructNode";
import TraitNode from "../nodes/TraitNode";
import ValueNode from "../nodes/ValueNode";
import WhileLoopNode from "../nodes/WhileLoopNode";
import { is_block_node } from "../nodes/check_node_type";
import type CheckStatus from "./CheckStatus";
import check_access_node from "./check_access_node";
import check_array_values_node from "./check_array_values_node";
import check_assignment_node from "./check_assignment_node";
import check_block_node from "./check_block_node";
import check_break_or_continue_node from "./check_break_or_continue_node";
import check_declaration_node from "./check_declaration_node";
import check_for_loop_node from "./check_for_loop_node";
import check_function_call_node from "./check_function_call_node";
import check_function_node from "./check_function_node";
import check_if_else_node from "./check_if_else_node";
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
    case "func_call": {
      check_function_call_node(node as FunctionCallNode, status);
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
    case "grouped": {
      check_node((node as GroupedNode).value, status);
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
    case "raw": {
      // Anything can go in here
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

  promote_allocations(node, status);
}

function promote_allocations(node: BaseNode, status: CheckStatus) {
  // If allocations have been hoisted out of e.g. function params in a child of
  // this node, and the parent of this node is a block node, add the allocations
  // to this node so that they will be declared in the block node, before they
  // are used in this node
  // E.g. something like
  // func print() {
  //   ...
  //   const z = "\{5}..."
  // }
  // will become
  // func print() {
  //   ...
  //   const _param_1 = 5.to_string()
  //   const z = _string_interpolate("%s...", _param_1)
  //   free(_param_1)
  // }
  if (status.allocations.length) {
    let parent = status.stack.at(-1);
    if (is_block_node(parent)) {
      node.allocations ??= [];
      node.allocations.push(...status.allocations);
      // HACK: We need allocations to be cleared in the status that this one may
      // have been cloned from, so we can't just set status.allocations = []
      status.allocations.length = 0;
    }
  }
}
