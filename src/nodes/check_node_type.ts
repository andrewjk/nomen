import BaseNode from "./BaseNode.ts";
import type BlockNode from "./BlockNode.ts";
import FunctionNode from "./FunctionNode.ts";
import type ReturningNode from "./ReturningNode.ts";
import RootNode from "./RootNode.ts";
import StructNode from "./StructNode.ts";
import TraitNode from "./TraitNode.ts";
import ValueNode from "./ValueNode.ts";

export function is_block_node(object: any): object is BlockNode {
  return "statements" in object;
}

export function is_returning_node(object: any): object is ReturningNode {
  return "return_type" in object;
}

export function is_root_node(node: BaseNode): node is RootNode {
  return node.node_type === "root";
}

export function is_struct_node(node: BaseNode): node is StructNode {
  return node.node_type === "struct";
}

export function is_trait_node(node: BaseNode): node is TraitNode {
  return node.node_type === "trait";
}

export function is_function_node(node: BaseNode): node is FunctionNode {
  return node.node_type === "func";
}

export function is_value_node(node: BaseNode): node is ValueNode {
  return node.node_type === "value";
}

/*
// These actually weren't as helpful as hoped (longer code, TypeScript struggles)

export function is_parameter_node(node: BaseNode): node is ParameterNode {
  return node.node_type === "param";
}

export function is_declaration_node(node: BaseNode): node is DeclarationNode {
  return node.node_type === "declare";
}

export function is_assignment_node(node: BaseNode): node is AssignmentNode {
  return node.node_type === "assign";
}

export function is_operation_node(node: BaseNode): node is OperationNode {
  return node.node_type === "op";
}

export function is_if_else_node(node: BaseNode): node is IfElseNode {
  return node.node_type === "if";
}

export function is_for_loop_node(node: BaseNode): node is ForLoopNode {
  return node.node_type === "for";
}

export function is_while_loop_node(node: BaseNode): node is WhileLoopNode {
  return node.node_type === "while";
}

export function is_function_call_node(node: BaseNode): node is FunctionCallNode {
  return node.node_type === "func_call";
}

export function is_access_node(node: BaseNode): node is AccessNode {
  return node.node_type === "access";
}

export function is_access_field_node(node: BaseNode): node is AccessFieldNode {
  return node.node_type === "access_field";
}

export function is_access_function_node(node: BaseNode): node is AccessFunctionCallNode {
  return node.node_type === "access_func";
}

export function is_branch_node(node: BaseNode): node is BranchNode {
  return node.node_type === "branch";
}

export function is_array_values_node(node: BaseNode): node is ArrayValuesNode {
  return node.node_type === "array";
}

export function is_range_node(node: BaseNode): node is RangeNode {
  return node.node_type === "range";
}

export function is_break_node(node: BaseNode): node is BreakNode {
  return node.node_type === "break";
}

export function is_continue_node(node: BaseNode): node is ContinueNode {
  return node.node_type === "continue";
}

export function is_panic_node(node: BaseNode): node is PanicNode {
  return node.node_type === "panic";
}

export function is_todo_node(node: BaseNode): node is TodoNode {
  return node.node_type === "todo";
}

export function is_return_node(node: BaseNode): node is ReturnNode {
  return node.node_type === "return";
}
*/
