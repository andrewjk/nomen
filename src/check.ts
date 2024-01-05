import AccessFieldNode from "./nodes/AccessFieldNode";
import AccessInvocationNode from "./nodes/AccessInvocationNode";
import AccessNode from "./nodes/AccessNode";
import ArrayValuesNode from "./nodes/ArrayValuesNode";
import AssignmentNode from "./nodes/AssignmentNode";
import BaseNode from "./nodes/BaseNode";
import type BlockNode from "./nodes/BlockNode";
import BreakNode from "./nodes/BreakNode";
import ContinueNode from "./nodes/ContinueNode";
import DeclarationNode from "./nodes/DeclarationNode";
import ForLoopNode from "./nodes/ForLoopNode";
import FunctionNode from "./nodes/FunctionNode";
import IfElseNode from "./nodes/IfElseNode";
import InvocationNode from "./nodes/InvocationNode";
import OperationNode from "./nodes/OperationNode";
import ParameterNode from "./nodes/ParameterNode";
import RangeNode from "./nodes/RangeNode";
import ReturnNode from "./nodes/ReturnNode";
import ReturningNode from "./nodes/ReturningNode";
import RootNode from "./nodes/RootNode";
import StructNode from "./nodes/StructNode";
import TraitNode from "./nodes/TraitNode";
import Type from "./nodes/Type";
import ValueNode from "./nodes/ValueNode";
import WhileLoopNode from "./nodes/WhileLoopNode";
import isReturningNode from "./nodes/isReturningNode";
import type CheckResult from "./types/CheckResult";
import type CompileError from "./types/CompileError";
import type StackValue from "./types/StackValue";

interface CheckStatus {
  // The current node
  stack: BaseNode[];
  // TODO: Scope these properly
  // Types (values, structs and traits) in scope
  types: string[];
  // For declarations and assignments, store the type if set, for use in ambigous nodes such as arrays
  expected_type?: Type;
  // Values (vars, params etc), structs, traits and functions in scope
  values: StackValue[];
  structs: StructNode[];
  traits: TraitNode[];
  functions: FunctionNode[];
  // Errors that have been encountered
  errors: CompileError[];
}

export default function check(root: BaseNode): CheckResult {
  const status: CheckStatus = {
    stack: [root],
    values: [],
    types: ["bool", "int", "string"],
    structs: [],
    traits: [],
    functions: [],
    errors: [],
  };

  if (root.node_type === "root") {
    gather_globals(root as RootNode, status);
  }

  check_node(root, status);

  return {
    ok: !status.errors.length,
    errors: status.errors,
  };
}

function gather_globals(root: RootNode, status: CheckStatus) {
  for (let node of root.statements) {
    switch (node.node_type) {
      case "struct": {
        const struct = node as StructNode;
        status.types.push(struct.name);
        status.values.push({
          declaration: "struct",
          name: struct.name,
          type: new Type(struct.name),
        });
        status.structs.push(struct);
        break;
      }
      case "trait": {
        const trait = node as TraitNode;
        status.types.push(trait.name);
        status.traits.push(trait);
        break;
      }
      case "func": {
        const func = node as FunctionNode;
        status.functions.push(func);
        break;
      }
    }
  }
}

function check_node(node: BaseNode, status: CheckStatus) {
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

function check_block_node(node: BlockNode, status: CheckStatus) {
  status.stack.push(node);
  for (let child of node.statements) {
    check_node(child, status);
  }
  status.stack.pop();
}

function check_struct_node(struct: StructNode, status: CheckStatus) {
  for (let trait of struct.traits) {
    if (!status.traits.find((t) => t.name === trait)) {
      status.errors.push({
        message: `Unknown trait: ${trait}`,
        start: struct.start,
      });
    }
  }

  // Add the `self` value that refers to the struct
  status.values.push({
    declaration: "const",
    name: "self",
    type: new Type(struct.name),
  });

  for (let decl of struct.fields) {
    check_declaration_node(decl, status);
  }

  for (let func of struct.functions) {
    check_function_node(func, status);
  }

  // TODO: Remove the `self` value

  status.types.push(struct.name);
  status.structs.push(struct);

  // Add a new value to the stack
  status.values.push({
    declaration: "struct",
    name: struct.name,
    type: new Type(struct.name),
  });
}

function check_trait_node(trait: TraitNode, status: CheckStatus) {
  for (let decl of trait.fields) {
    check_declaration_node(decl, status);
  }

  for (let func of trait.functions) {
    check_function_node(func, status);
  }

  status.types.push(trait.name);
  status.traits.push(trait);
}

function check_function_node(func: FunctionNode, status: CheckStatus) {
  for (let param of func.params) {
    check_function_parameter_node(param, status);
  }

  if (func.return_type.name) {
    if (!check_type_exists(func.return_type, status, func.return_type_start!)) {
      // Set the return type to the unknown type so that returns won't get checked
      func.return_type = new Type("?");
    }
  }

  status.functions.push(func);

  check_block_node(func, status);
}

function check_function_parameter_node(param: ParameterNode, status: CheckStatus) {
  if (param.type.name) {
    check_type_exists(param.type, status, param.type_start!);
  }

  if (param.default_value) {
    check_type_and_value_match(
      param.type,
      type_from_value(param.default_value, status),
      param.default_value,
      status,
      param.default_value_start!,
      "param default",
    );
    if (!param.type.name) {
      param.type = type_from_value(param.default_value, status);
    }
  }
}

function check_declaration_node(decl: DeclarationNode, status: CheckStatus) {
  // NOTE: At this point we must have either type or value
  if (decl.type.name) {
    check_type_exists(decl.type, status, decl.type_start!);
  }

  if (decl.value) {
    const old_expected_type = status.expected_type;
    status.expected_type = decl.type;
    check_node(decl.value, status);
    status.expected_type = old_expected_type;

    check_type_and_value_match(
      decl.type,
      type_from_value_node(decl.value, status),
      value_from_value_node(decl.value),
      status,
      decl.value.start,
      "declaration",
    );

    if (!decl.type.name) {
      decl.type = type_from_value_node(decl.value, status);
    }
  }

  // Add a new value to the stack
  status.values.push({
    declaration: decl.declaration,
    name: decl.name,
    type: decl.type,
  });
}

function check_assignment_node(assign: AssignmentNode, status: CheckStatus) {
  check_node(assign.left_value, status);

  const old_expected_type = status.expected_type;
  status.expected_type = type_from_value_node(assign.left_value, status);
  check_node(assign.right_value, status);
  status.expected_type = old_expected_type;

  // Make sure the left value exists and can be assigned to
  const left_value_name = value_from_value_node(assign.left_value);
  const left_value = status.values.find((v) => v.name === left_value_name);
  if (!left_value) {
    status.errors.push({
      message: `Unknown variable: ${left_value_name}`,
      start: assign.left_value!.start,
    });
  } else if (left_value.declaration === "const") {
    status.errors.push({
      message: `Assignment to const: ${left_value_name}`,
      start: assign.left_value!.start,
    });
  }

  if (left_value)
    check_type_and_value_match(
      left_value.type,
      type_from_value_node(assign.right_value, status),
      value_from_value_node(assign.right_value),
      status,
      assign.right_value.start,
      "assignment",
    );
}

function check_invocation_node(invoke: InvocationNode, status: CheckStatus) {
  const func = status.functions.find((f) => f.name === invoke.name);
  check_invocation_function(invoke, status, func);
}

function check_invocation_function(
  invoke: InvocationNode | AccessInvocationNode,
  status: CheckStatus,
  func?: FunctionNode,
) {
  for (let param of invoke.params) {
    check_node(param, status);
  }

  // HACK:
  if (func) {
    invoke.type = func.return_type;
  }
  if (!func) {
    status.errors.push({
      message: `Function not found: ${invoke.name}`,
      start: invoke.start,
    });
  } else if (invoke.params.length > func.params.length) {
    status.errors.push({
      message: `Too many parameters for function: ${invoke.name}`,
      start: invoke.start,
    });
  } else if (invoke.params.length < func.params.length) {
    status.errors.push({
      message: `Parameters missing for function: ${invoke.name}`,
      start: invoke.start,
    });
  } else if (func.visibility === "sec") {
    // TODO: You CAN do this from within the correct scope
    status.errors.push({
      message: `Can't access secret function: ${invoke.name}`,
      start: invoke.start,
    });
  } else {
    invoke.params.forEach((param, i) => {
      check_type_and_value_match(
        func.params[i].type,
        type_from_value_node(param, status),
        value_from_value_node(param),
        status,
        param.start,
        "param",
      );
    });
  }
}

function check_access_node(node: AccessNode, status: CheckStatus) {
  check_node(node.source, status);

  const source_type = type_from_value_node(node.source, status);
  if (!source_type.name) {
    status.errors.push({
      message: `Unknown target: ${value_from_value_node(node.source)}`,
      start: node.source.start,
    });
    return;
  }

  switch (node.access.node_type) {
    case "ac_field": {
      check_access_field_node(source_type, node.access as AccessFieldNode, status);
      break;
    }
    case "ac_invoke": {
      check_access_invocation_node(source_type, node.access as AccessInvocationNode, status);
      break;
    }
  }
}

function check_access_field_node(source_type: Type, field: AccessFieldNode, status: CheckStatus) {
  const struct = status.structs.find((s) => s.name === source_type.name);
  let prop = struct?.fields.find((f) => f.name === field.name);
  if (!prop) {
    const trait = status.traits.find((s) => s.name === source_type.name);
    prop = trait?.fields.find((f) => f.name === field.name);
  }
  if (prop) {
    if (prop.visibility === "sec") {
      // TODO: You CAN do this from within the correct scope
      status.errors.push({
        message: `Can't access secret field: ${field.name}`,
        start: field.start,
      });
    } else {
      field.type = prop.type;
    }
  } else {
    status.errors.push({
      message: `Field not found: ${field.name}`,
      start: field.start,
    });
  }
}

function check_access_invocation_node(
  source_type: Type,
  invoke: AccessInvocationNode,
  status: CheckStatus,
) {
  const struct = status.structs.find((s) => s.name === source_type.name);
  let func = struct?.functions.find((f) => f.name === invoke.name);
  if (!func) {
    const trait = status.traits.find((s) => s.name === source_type.name);
    func = trait?.functions.find((f) => f.name === invoke.name);
  }
  check_invocation_function(invoke, status, func);
}

function check_if_else_node(if_else: IfElseNode, status: CheckStatus) {
  check_node(if_else.condition, status);
  const condition_type = type_from_value_node(if_else.condition, status);
  if (type_name(condition_type) !== "bool") {
    status.errors.push({
      message: `If/else condition must be a bool, not ${type_name(condition_type)}`,
      start: if_else.condition.start,
    });
  }

  status.stack.push(if_else);
  check_block_node(if_else.if_branch, status);
  if (if_else.else_branch) {
    check_block_node(if_else.else_branch, status);
  }
  status.stack.pop();
}

function check_for_loop_node(for_loop: ForLoopNode, status: CheckStatus) {
  if (for_loop.list) {
    check_node(for_loop.list, status);

    const list_type = type_from_value_node(for_loop.list, status);
    if (!list_type.is_array) {
      status.errors.push({
        message: `For loop list must be an array, not ${list_type.name}`,
        start: for_loop.list.start,
      });
    }

    if (for_loop.item) {
      for_loop.item.type = new Type(list_type.name);

      status.values.push({
        declaration: "var",
        name: for_loop.item.value,
        type: for_loop.item.type,
      });
    }
  }

  check_block_node(for_loop, status);
}

function check_while_loop_node(while_loop: WhileLoopNode, status: CheckStatus) {
  check_node(while_loop.condition, status);
  const condition_type = type_from_value_node(while_loop.condition, status);
  if (type_name(condition_type) !== "bool") {
    status.errors.push({
      message: `While loop condition must be a bool, not ${type_name(condition_type)}`,
      start: while_loop.condition.start,
    });
  }

  check_block_node(while_loop, status);
}

function check_operation_node(op: OperationNode, status: CheckStatus) {
  check_node(op.left_value, status);
  check_node(op.right_value, status);

  const left_type = type_from_value_node(op.left_value, status);
  const right_type = type_from_value_node(op.right_value, status);
  check_type_and_value_match(
    left_type,
    right_type,
    value_from_value_node(op.right_value),
    status,
    op.right_value.start,
    "operation",
  );

  // HACK: this needs to come from operator funcs for each operator and type combination
  switch (op.op) {
    case "+":
    case "-":
    case "*":
    case "/":
    case "%": {
      //op.type = new Type("int");
      op.type = left_type;
      break;
    }
    case "==":
    case "!=":
    case ">":
    case ">=":
    case "<":
    case "<=":
    case "&&":
    case "||": {
      op.type = new Type("bool");
      break;
    }
    default: {
      status.errors.push({
        message: `Unknown operator: ${op.op}`,
        start: op.start,
      });
    }
  }
}

function check_array_values_node(array: ArrayValuesNode, status: CheckStatus) {
  // The type of items in the array, which we will check each value against
  let array_item_type = new Type(array.type.name);

  // If there is an expected type of the array (e.g. for declarations), use it
  if (!array.type.name && status.expected_type) {
    array.type = status.expected_type;
    array_item_type = new Type(array.type.name);
  }

  for (let value of array.values) {
    check_node(value, status);

    const value_type = type_from_value_node(value, status);

    // If the array has no type, use the type from the first value
    if (!array.type.name) {
      array.type = value_type;
      array_item_type = new Type(array.type.name);
    }

    check_type_and_value_match(
      array_item_type,
      value_type,
      value_from_value_node(value),
      status,
      value.start,
      "array",
    );
  }

  if (!array.type.length) {
    array.type.length = new ValueNode(-1, array.values.length.toString(), "int");
  }
}

function check_range_node(range: RangeNode, status: CheckStatus) {
  check_node(range.left_value, status);
  check_node(range.right_value, status);

  check_type_and_value_match(
    type_from_value_node(range.left_value, status),
    type_from_value_node(range.right_value, status),
    value_from_value_node(range.right_value),
    status,
    range.right_value.start,
    "range",
  );
}

function check_value_node(value: ValueNode, status: CheckStatus) {
  // TODO: If there's already a type, check that the value matches
  value.type = type_from_value(value.value, status);
}

function check_break_or_continue_node(node: BreakNode | ContinueNode, status: CheckStatus) {
  // Go up the stack looking for a for or while node
  let found = false;
  for (let i = status.stack.length - 1; i >= 0; i--) {
    if (status.stack[i].node_type === "for" || status.stack[i].node_type === "while") {
      found = true;
      break;
    }
  }

  if (!found) {
    const description = node.node_type.substring(0, 1).toUpperCase() + node.node_type.substring(1);
    status.errors.push({
      message: `${description} must be inside a for or while loop`,
      start: node.start,
    });
  }
}

function check_return_node(ret: ReturnNode, status: CheckStatus) {
  check_node(ret.value, status);

  ret.type = type_from_value_node(ret.value, status);

  // Go up the stack looking for a returning node
  let func: ReturningNode | null = null;
  for (let i = status.stack.length - 1; i >= 0; i--) {
    if (isReturningNode(status.stack[i])) {
      func = status.stack[i] as ReturningNode;
    }
  }

  if (func) {
    if (func.return_type.name) {
      if (func.return_type.name !== "?") {
        check_type_and_value_match(
          func.return_type,
          type_from_value_node(ret.value, status),
          value_from_value_node(ret.value),
          status,
          ret.value.start,
          "return",
        );
      }
    } else {
      func.return_type = ret.type;
    }
  }
}

// UTILS

function check_type_and_value_match(
  target_type: Type,
  expression_type: Type,
  // TODO: Do we need the value?? It's type should haev been retrieved??
  value: string,
  status: CheckStatus,
  i: number,
  node_type: string,
) {
  // TODO: Should i just be cehcking that types exist for target_type and expression_type???

  if (target_type.name) {
    // TODO: thorough checking
    if (target_type.is_array !== expression_type.is_array) {
      status.errors.push({
        message: `Type mismatch in ${node_type}: ${type_name(
          expression_type,
        )} (expected ${type_name(target_type)})`,
        start: i,
      });
    } else if (target_type.name !== expression_type.name) {
      // It might be a struct with a matching trait
      // TOOD: Check this in more places
      const struct = status.structs.find((f) => f.name === expression_type.name);
      if (struct?.traits.includes(target_type.name)) {
        return;
      }

      status.errors.push({
        message: !expression_type.name
          ? `Type mismatch in ${node_type}: unknown value ${value} (expected ${type_name(
              target_type,
            )})`
          : `Type mismatch in ${node_type}: ${type_name(expression_type)} (expected ${type_name(
              target_type,
            )})`,
        start: i,
      });
    }
  } else {
    if (!expression_type.name) {
      status.errors.push({
        message: `Unknown value: ${value}`,
        start: i,
      });
    }
  }
}

function check_type_exists(type: Type, status: CheckStatus, start: number): boolean {
  if (!status.types.includes(type.name)) {
    status.errors.push({
      message: `Unknown type: ${type_name(type)}`,
      start,
    });
    return false;
  }
  return true;
}

function type_from_value(value: string, status: CheckStatus): Type {
  const decl_value = status.values.find((v) => v.name === value);
  if (decl_value) {
    return decl_value.type;
  } else if (value === "true" || value === "false") {
    return new Type("bool");
  } else if (value.startsWith('"') && value.endsWith('"')) {
    return new Type("string");
  } else if (/^\d+$/.test(value)) {
    return new Type("int");
  } else {
    return new Type("");
  }
}

function type_from_value_node(node: BaseNode, status: CheckStatus): Type {
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

function value_from_value_node(node: BaseNode): string {
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

function find_parent_of_type(type: string, status: CheckStatus): BaseNode | undefined {
  for (let i = status.stack.length - 1; i >= 0; i--) {
    if (status.stack[i].node_type === type) {
      return status.stack[i];
    }
  }
}

function type_name(type: Type) {
  return `${type.name}${type.is_array ? `[]` : ""}`;
}
