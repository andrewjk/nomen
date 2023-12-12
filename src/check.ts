import AccessFieldNode from "./nodes/AccessFieldNode";
import AccessInvocationNode from "./nodes/AccessInvocationNode";
import AccessNode from "./nodes/AccessNode";
import ArrayValuesNode from "./nodes/ArrayValuesNode";
import AssignmentNode from "./nodes/AssignmentNode";
import BaseNode from "./nodes/BaseNode";
import DeclarationNode from "./nodes/DeclarationNode";
import ForNode from "./nodes/ForNode";
import FunctionNode from "./nodes/FunctionNode";
import InvocationNode from "./nodes/InvocationNode";
import OperationNode from "./nodes/OperationNode";
import ParameterNode from "./nodes/ParameterNode";
import RangeNode from "./nodes/RangeNode";
import ReturnNode from "./nodes/ReturnNode";
import RootNode from "./nodes/RootNode";
import StructNode from "./nodes/StructNode";
import TraitNode from "./nodes/TraitNode";
import ValueNode from "./nodes/ValueNode";
import type CheckResult from "./types/CheckResult";
import type CompileError from "./types/CompileError";
import type StackValue from "./types/StackValue";

interface CheckStatus {
  // The current node
  stack: BaseNode[];
  // TODO: Scope these properly
  // Types (values, structs and traits) in scope
  types: string[];
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
    types: ["int", "string"],
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
          type: struct.name,
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
      check_statements(node as RootNode, status);
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
    case "for": {
      check_for_node(node as ForNode, status);
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

function check_statements(
  node: BaseNode & { statements: BaseNode[] },
  status: CheckStatus,
) {
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

  for (let decl of struct.fields) {
    check_declaration_node(decl, status);
  }

  for (let func of struct.functions) {
    check_function_node(func, status);
  }

  status.types.push(struct.name);
  status.structs.push(struct);

  // Add a new value to the stack
  status.values.push({
    declaration: "struct",
    name: struct.name,
    type: struct.name,
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

  if (func.return_type) {
    if (!check_type_exists(func.return_type, status, func.return_type_start!)) {
      func.return_type = "?";
    }
  }

  status.functions.push(func);

  check_statements(func, status);
}

function check_function_parameter_node(
  param: ParameterNode,
  status: CheckStatus,
) {
  if (param.type) {
    if (!check_type_exists(param.type, status, param.type_start!)) {
      param.type = "?";
    }
  }

  if (param.default_value) {
    check_type_and_value_match(
      param.type,
      type_from_value(param.default_value, status),
      param.default_value,
      status,
      param.default_value_start!,
    );
    param.type = param.type || type_from_value(param.default_value, status);
  }
}

function check_declaration_node(decl: DeclarationNode, status: CheckStatus) {
  // NOTE: At this point we must have either type or value
  if (decl.type) {
    check_type_exists(decl.type, status, decl.type_start!);
  }

  if (decl.value) {
    check_node(decl.value, status);

    check_type_and_value_match(
      decl.type,
      type_from_value_node(decl.value, status),
      value_from_value_node(decl.value, status),
      status,
      decl.value.start,
    );

    if (!decl.type) {
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
  if (assign.left_value) {
    check_node(assign.left_value, status);
  }
  if (assign.right_value) {
    check_node(assign.right_value, status);
  }

  // Make sure the left value exists and can be assigned to
  const lvalueName = value_from_value_node(assign.left_value!, status);
  const lvalue = status.values.find((v) => v.name === lvalueName);
  if (!lvalue) {
    status.errors.push({
      message: `Unknown variable: ${lvalueName}`,
      start: assign.left_value!.start,
    });
  } else if (lvalue.declaration === "const") {
    status.errors.push({
      message: `Assignment to const: ${lvalueName}`,
      start: assign.left_value!.start,
    });
  }

  if (lvalue)
    check_type_and_value_match(
      lvalue.type,
      type_from_value_node(assign.right_value!, status),
      value_from_value_node(assign.right_value!, status),
      status,
      assign.right_value!.start,
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
  } else {
    invoke.params.forEach((param, i) => {
      //check_node(param, status);

      const paramType = func.params[i].type;
      const valueType = type_from_value_node(param, status);
      if (valueType === "?") {
        status.errors.push({
          message: `Type mismatch -- unknown value type: ${value_from_value_node(
            param,
            status,
          )} cannot be used for ${paramType} parameter`,
          start: param.start,
        });
      } else if (valueType !== paramType) {
        status.errors.push({
          message: `Type mismatch: ${valueType} cannot be used for ${paramType} parameter`,
          start: param.start,
        });
      }
    });
  }
}

function check_access_node(node: AccessNode, status: CheckStatus) {
  check_node(node.source, status);

  const source_type = type_from_value_node(node.source, status);
  switch (node.access.node_type) {
    case "ac_field": {
      check_access_field_node(
        source_type,
        node.access as AccessFieldNode,
        status,
      );
      break;
    }
    case "ac_invoke": {
      check_access_invocation_node(
        source_type,
        node.access as AccessInvocationNode,
        status,
      );
      break;
    }
  }
}

function check_access_field_node(
  source_type: string,
  field: AccessFieldNode,
  status: CheckStatus,
) {
  const struct = status.structs.find((s) => s.name === source_type);
  let prop = struct?.fields.find((f) => f.name === field.name);
  if (!prop) {
    const trait = status.traits.find((s) => s.name === source_type);
    prop = trait?.fields.find((f) => f.name === field.name);
  }
  if (prop) {
    field.type = prop.type;
  } else {
    status.errors.push({
      message: `Field not found: ${field.name}`,
      start: field.start,
    });
  }
}

function check_access_invocation_node(
  source_type: string,
  invoke: AccessInvocationNode,
  status: CheckStatus,
) {
  const struct = status.structs.find((s) => s.name === source_type);
  let func = struct?.functions.find((f) => f.name === invoke.name);
  if (!func) {
    const trait = status.traits.find((s) => s.name === source_type);
    func = trait?.functions.find((f) => f.name === invoke.name);
  }
  check_invocation_function(invoke, status, func);
}

function check_for_node(for_loop: ForNode, status: CheckStatus) {
  if (for_loop.list) {
    check_node(for_loop.list, status);

    const list_type = type_from_value_node(for_loop.list, status);
    if (!/\[.*\]/.test(list_type)) {
      status.errors.push({
        message: `For loop list must be an array, not ${list_type}`,
        start: for_loop.list.start,
      });
    }

    if (for_loop.item) {
      // HACK: handle array types properly
      for_loop.item.type = list_type.replace(/\[.*\]/, "");

      status.values.push({
        declaration: "var",
        name: for_loop.item.value,
        type: for_loop.item.type,
      });
    }
  }

  check_statements(for_loop, status);
}

function check_operation_node(op: OperationNode, status: CheckStatus) {
  if (op.left_value) {
    check_node(op.left_value, status);
  }
  if (op.right_value) {
    check_node(op.right_value, status);
  }

  // Check compatibility of types
  if (op.left_value && op.right_value) {
    const left_type = type_from_value_node(op.left_value, status);
    const right_type = type_from_value_node(op.right_value, status);
    op.type = left_type;

    if (left_type !== right_type) {
      status.errors.push({
        message: `Invalid type in operation: ${right_type} (expected ${left_type})`,
        start: op.right_value.start,
      });
    }
  }
}

function check_array_values_node(array: ArrayValuesNode, status: CheckStatus) {
  for (let value of array.values) {
    check_node(value, status);

    const type = type_from_value_node(value, status);
    const array_type = type + `[${array.values.length}]`;
    if (!array.type) {
      array.type = array_type;
    } else if (array.type !== array_type) {
      // It might have a trait
      // TOOD: Check this in more places
      const struct = status.structs.find((f) => f.name === type);
      const maybeTrait = array.type.replace(/\[.*\]/, "");
      if (struct?.traits.includes(maybeTrait)) {
        continue;
      }

      status.errors.push({
        message: `Invalid type in array: ${type} (expected ${array.type.replace(
          /\[.*\]/,
          "",
        )})`,
        start: value.start,
      });
    }
  }
}

function check_range_node(range: RangeNode, status: CheckStatus) {
  if (range.left_value) {
    check_node(range.left_value, status);
  }
  if (range.right_value) {
    check_node(range.right_value, status);
  }

  // Check compatibility of types
  if (range.left_value && range.right_value) {
    const left_type = type_from_value_node(range.left_value, status);
    const right_type = type_from_value_node(range.right_value, status);
    //range.type = left_type;

    if (left_type !== right_type) {
      status.errors.push({
        message: `Invalid type in range: ${right_type} (expected ${left_type})`,
        start: range.right_value.start,
      });
    }
  }
}

function check_value_node(value: ValueNode, status: CheckStatus) {
  value.type = type_from_value(value.value, status);
}

function check_return_node(ret: ReturnNode, status: CheckStatus) {
  check_node(ret.value, status);

  ret.type = type_from_value_node(ret.value, status);

  // Go up the stack looking for our function
  const func = find_parent_of_type("func", status) as FunctionNode;

  if (func.return_type && func.return_type !== "?") {
    check_type_and_value_match(
      func.return_type,
      type_from_value_node(ret.value, status),
      value_from_value_node(ret.value, status),
      status,
      ret.start,
    );
  }
}

// UTILS

function check_type_and_value_match(
  target_type: string,
  expression_type: string,
  value: string,
  status: CheckStatus,
  i: number,
) {
  if (target_type) {
    // HACK: Remove array length
    const target_type_is_array = /\[.*\]/.test(target_type);
    target_type = target_type.replace(/\[.*\]/, "");
    const expression_type_is_array = /\[.*\]/.test(expression_type);
    expression_type = expression_type.replace(/\[.*\]/, "");
    // TODO: thorough checking
    if (target_type_is_array && !expression_type_is_array) {
      status.errors.push({
        message: `Type mismatch: ${expression_type}${
          expression_type_is_array ? "[]" : ""
        } cannot be assigned to ${target_type}${
          target_type_is_array ? "[]" : ""
        } variable`,
        start: i,
      });
    } else if (target_type !== expression_type) {
      // It might be a struct with a matching trait
      // TOOD: Check this in more places
      const struct = status.structs.find((f) => f.name === expression_type);
      if (struct?.traits.includes(target_type)) {
        return;
      }

      status.errors.push({
        message:
          expression_type === "?"
            ? `Type mismatch -- unknown value type: ${value}`
            : `Type mismatch: ${expression_type}${
                expression_type_is_array ? "[]" : ""
              } cannot be assigned to ${target_type}${
                target_type_is_array ? "[]" : ""
              } variable`,
        start: i,
      });
    }
  } else {
    if (expression_type === "?") {
      status.errors.push({
        message: `Unknown value type: ${value}`,
        start: i,
      });
    }
  }
}

function check_type_exists(
  type: string,
  status: CheckStatus,
  start: number,
): boolean {
  // Remove array brackets
  type = type.replace(/\[.*\]/, "");
  if (!status.types.includes(type)) {
    status.errors.push({
      message: `Unknown type: ${type}`,
      start,
    });
    return false;
  }
  return true;
}

function type_from_value(value: string, status: CheckStatus): string {
  const decl_value = status.values.find((v) => v.name === value);
  if (decl_value) {
    return decl_value.type;
  } else if (value.startsWith('"') && value.endsWith('"')) {
    return "string";
  } else if (/^\d+$/.test(value)) {
    return "int";
  } else {
    return "?";
  }
}

function type_from_value_node(node: BaseNode, status: CheckStatus): string {
  switch (node.node_type) {
    case "value": {
      return type_from_value((node as ValueNode).value, status);
    }
    case "access": {
      return type_from_value_node((node as AccessNode).access, status);
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
    case "range": {
      return (
        type_from_value_node((node as RangeNode).left_value!, status) + "[]"
      );
    }
  }
  return "?";
}

function value_from_value_node(node: BaseNode, status: CheckStatus): string {
  switch (node.node_type) {
    case "value": {
      return (node as ValueNode).value;
    }
    case "access": {
      return value_from_value_node((node as AccessNode).access, status);
    }
    case "ac_field": {
      return (node as AccessFieldNode).name;
    }
  }
  return "?";
}

function find_parent_of_type(
  type: string,
  status: CheckStatus,
): BaseNode | undefined {
  for (let i = status.stack.length - 1; i >= 0; i--) {
    if (status.stack[i].node_type === type) {
      return status.stack[i];
    }
  }
}
