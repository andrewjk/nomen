import type AccessFieldNode from "./types/AccessFieldNode";
import type AccessInvocationNode from "./types/AccessInvocationNode";
import type AccessNode from "./types/AccessNode";
import type ArrayValuesNode from "./types/ArrayValuesNode";
import type AssignmentNode from "./types/AssignmentNode";
import type DeclarationNode from "./types/DeclarationNode";
import type ForNode from "./types/ForNode";
import type FunctionNode from "./types/FunctionNode";
import type InvocationNode from "./types/InvocationNode";
import type OperationNode from "./types/OperationNode";
import type ParameterNode from "./types/ParameterNode";
import type ParseError from "./types/ParseError";
import type ParseNode from "./types/ParseNode";
import type ParseResult from "./types/ParseResult";
import type ParseValue from "./types/ParseValue";
import type RangeNode from "./types/RangeNode";
import type ReturnNode from "./types/ReturnNode";
import type StructNode from "./types/StructNode";
import type Token from "./types/Token";
import type TraitNode from "./types/TraitNode";
import type ValueNode from "./types/ValueNode";

interface ParseStatus {
  // The tokens
  tokens: Token[];
  // The current token index
  i: number;
  // The current node
  stack: ParseNode[];
  // TODO: Scope these properly
  // Types (values, structs and traits) in scope
  types: string[];
  // Values (vars, params etc), structs, traits and functions in scope
  values: ParseValue[];
  structs: StructNode[];
  traits: TraitNode[];
  functions: FunctionNode[];
  // Errors that have been encountered
  errors: ParseError[];
}

export default function parse(tokens: Token[]): ParseResult {
  const root: ParseNode = {
    node_type: "root",
    children: [],
    i: 0,
  };

  const status: ParseStatus = {
    tokens,
    i: 0,
    stack: [root],
    values: [],
    types: ["int", "string"],
    structs: [],
    traits: [],
    functions: [],
    errors: [],
  };

  parse_statement(status);

  return {
    ok: !status.errors.length,
    root,
    errors: status.errors,
  };
}

function parse_statement(status: ParseStatus) {
  while (true) {
    const value = peek_current(status);
    if (!value) {
      break;
    }

    // Ignore comments
    if (value.startsWith("//") || value.startsWith("/*")) {
      consume(status);
      continue;
    }

    // First check for a keyword (var, if, switch, etc), then check for a following operator (=, +, etc)
    switch (value) {
      case "const":
      case "var": {
        parse_declaration(value, status);
        break;
      }
      case "struct": {
        parse_struct(status);
        break;
      }
      case "trait": {
        parse_trait(status);
        break;
      }
      case "func": {
        parse_function(status);
        break;
      }
      case "for": {
        parse_for_loop(status);
        break;
      }
      case "return": {
        parse_return(status);
        break;
      }
      case "}": {
        return;
      }
      default: {
        parse_statement_start(status);
        break;
      }
    }
  }
}

function parse_statement_start(status: ParseStatus) {
  const i = status.tokens[status.i].i;
  const value = consume(status);
  const type = type_from_value(value, status);
  let node: ParseNode = {
    node_type: "value",
    value,
    type,
    children: [],
    i,
  } as ValueNode;

  while (true) {
    const next_value = peek_current(status);
    switch (next_value) {
      case ".": {
        accept(".", status);
        const access: AccessNode = {
          node_type: "access",
          source: node,
          access: parse_access(value, type, status),
          children: [],
          i: node.i,
        };
        node = access;
        break;
      }
      case "(": {
        accept("(", status);
        const invoke: InvocationNode = {
          node_type: "invoke",
          name: value,
          params: [],
          type,
          children: [],
          i: node.i,
        };
        if (peek_current(status) !== ")") {
          parse_invocation_parameter(invoke, status);
        }
        expect(")", status);
        check_invocation_node(invoke, status);
        node = invoke;
        break;
      }
      case "=": {
        accept("=", status);
        const assign: AssignmentNode = {
          node_type: "assign",
          left_value: node,
          right_value: parse_expression(status),
          children: [],
          i: node.i,
        };
        check_assignment_node(assign, status);
        node = assign;
        break;
      }
      default: {
        const parent = status.stack.at(-1)!;
        switch (parent.node_type) {
          case "root":
          case "func":
          case "for": {
            parent.children.push(node);
            break;
          }
          default: {
            status.errors.push({
              message: `${node_name(node)} cannot appear here`,
              i: node.i,
            });
            return;
          }
        }
        return;
      }
    }
  }
}

/**
 * An expression returns a value and can be used e.g. on the right side of an assignment, as the
 * initial value of a declaration or as a parameter value in a function call
 */
function parse_expression(status: ParseStatus): ParseNode {
  // First check for an array of values
  const i = status.tokens[status.i].i;
  let value = consume(status);
  let type = type_from_value(value, status);
  let node: ParseNode;
  if (value === "[") {
    node = {
      node_type: "array",
      values: [],
      type: "",
      children: [],
      i,
    } as ArrayValuesNode;
    if (peek_current(status) !== "]") {
      parse_array_value(node as ArrayValuesNode, status);
    }
    expect("]", status);
    check_array_values_node(node as ArrayValuesNode, status);
  } else {
    node = {
      node_type: "value",
      value,
      type,
      children: [],
      i,
    } as ValueNode;
  }

  while (true) {
    const next_value = peek_current(status);
    switch (next_value) {
      case ".": {
        accept(".", status);
        const access: AccessNode = {
          node_type: "access",
          source: node,
          access: parse_access(value, type, status),
          children: [],
          i: node.i,
        };
        node = access;
        // TODO: This should be a type prop on AccessNode
        switch (access.access.node_type) {
          case "accfld": {
            value = (access.access as AccessFieldNode).name;
            type = (access.access as AccessFieldNode).type;
            break;
          }
          case "accinv": {
            value = (access.access as AccessInvocationNode).name;
            type = (access.access as AccessInvocationNode).type;
            break;
          }
        }
        break;
      }
      case "(": {
        accept("(", status);
        const invoke: InvocationNode = {
          node_type: "invoke",
          name: value,
          params: [],
          type,
          children: [],
          i,
        };
        if (peek_current(status) !== ")") {
          parse_invocation_parameter(invoke, status);
        }
        expect(")", status);
        check_invocation_node(invoke, status);
        node = invoke;
        value = invoke.name;
        type = invoke.type;
        break;
      }
      case "+":
      case "-": {
        consume(status);
        const op: OperationNode = {
          node_type: "op",
          op: next_value,
          left_value: node,
          // TODO: Proper order of operations
          right_value: parse_expression(status),
          type: "",
          children: [],
          i,
        };
        check_operation_node(op, status);
        node = op;
        //value = op.name;
        //type = op.type;
        break;
      }
      case "..":
      case ".=": {
        consume(status);
        const range: RangeNode = {
          node_type: "range",
          left_value: node,
          right_value: parse_expression(status),
          inclusive: next_value === ".=",
          children: [],
          i,
        };
        node = range;
        //value = op.name;
        //type = op.type;
        break;
      }
      default: {
        return node;
      }
    }
  }
}

// DECLARATION

function parse_declaration(declaration: "const" | "var", status: ParseStatus) {
  const decl: DeclarationNode = {
    node_type: "decl",
    declaration,
    name: "",
    type: "",
    children: [],
    i: status.tokens[status.i].i,
  };
  const parent = status.stack.at(-1)!;
  switch (parent.node_type) {
    case "root":
    case "func": {
      parent.children.push(decl);
      break;
    }
    case "trait":
    case "struct": {
      (parent as StructNode).fields.push(decl);
      break;
    }
    default: {
      status.errors.push({
        message: "Declaration cannot appear here",
        i: decl.i,
      });
      consume(status);
      return;
    }
  }

  accept(declaration, status);
  decl.name = consume(status);
  if (accept(":", status)) {
    decl.type = consume(status);
    // HACK: Need to be fancier about this -- with a type node?
    if (peek_current(status) === "[") {
      while (!decl.type.endsWith("]")) {
        decl.type += consume(status);
      }
    }
    if (!check_type_exists(decl.type, status)) {
      decl.type = "?";
    }
  }
  if (accept("=", status)) {
    decl.value = parse_expression(status);
    check_type_and_value_match(
      decl.type,
      type_from_value_node(decl.value, status),
      value_from_value_node(decl.value, status),
      status,
    );
    decl.type = decl.type || type_from_value_node(decl.value, status);
  }

  // Check type or value has been set
  if (!decl.type && !decl.value) {
    status.errors.push({
      message: `Expected type or default value`,
      i: status.tokens[status.i - 1].i,
    });
  }

  // Add a new value to the stack
  status.values.push({
    declaration: decl.declaration,
    name: decl.name,
    type: decl.type,
  });
}

// STRUCT

function parse_struct(status: ParseStatus) {
  const struct: StructNode = {
    node_type: "struct",
    name: "",
    traits: [],
    fields: [],
    functions: [],
    children: [],
    i: status.tokens[status.i].i,
  };
  status.stack.push(struct);

  accept("struct", status);
  struct.name = consume(status);
  if (accept(":", status)) {
    struct.traits.push(consume(status));
    while (accept(",", status)) {
      struct.traits.push(consume(status));
    }
  }
  if (expect("{", status)) {
    parse_statement(status);
    expect("}", status);
  }

  // Add the init function to the struct
  struct.functions.unshift({
    node_type: "func",
    name: "init",
    params: struct.fields
      .filter((f) => !f.value)
      .map((f) => {
        return {
          node_type: "param",
          name: f.name,
          type: f.type,
          default_value: f.value,
          children: [],
          i: 0,
        } as ParameterNode;
      }),
    return_type: struct.name,
    children: [],
    i: 0,
  } as FunctionNode);

  status.stack.pop();

  status.types.push(struct.name);
  status.structs.push(struct);

  // TODO: Add the default fields and functions from the trait?
  const parent = status.stack.at(-1)!;
  switch (parent.node_type) {
    case "root":
    case "func": {
      parent.children.push(struct);
      break;
    }
    default: {
      status.errors.push({
        message: "Struct cannot appear here",
        i: struct.i,
      });
      break;
    }
  }

  // Add a new value to the stack
  status.values.push({
    declaration: "struct",
    name: struct.name,
    type: struct.name,
  });
}

// TRAIT

function parse_trait(status: ParseStatus) {
  //const error_start = status.tokens[status.i].i;
  const trait: TraitNode = {
    node_type: "trait",
    name: "",
    fields: [],
    functions: [],
    children: [],
    i: status.tokens[status.i].i,
  };
  status.stack.push(trait);

  accept("trait", status);
  trait.name = consume(status);
  if (expect("{", status)) {
    parse_statement(status);
    expect("}", status);
  }

  status.stack.pop();

  status.types.push(trait.name);
  status.traits.push(trait);

  const parent = status.stack.at(-1)!;
  switch (parent.node_type) {
    case "root":
    case "func": {
      parent.children.push(trait);
      break;
    }
    default: {
      status.errors.push({
        message: "Trait cannot appear here",
        i: trait.i,
      });
      break;
    }
  }
}

// ASSIGNMENT

function check_assignment_node(assign: AssignmentNode, status: ParseStatus) {
  // Make sure the left value exists and can be assigned to
  const lvalueName = value_from_value_node(assign.left_value!, status);
  const lvalue = status.values.find((v) => v.name === lvalueName);
  if (!lvalue) {
    status.errors.push({
      i: assign.left_value!.i,
      message: `Unknown variable: ${lvalueName}`,
    });
  } else if (lvalue.declaration === "const") {
    status.errors.push({
      i: assign.left_value!.i,
      message: `Assignment to const: ${lvalueName}`,
    });
  }

  // Make sure the types of the left and right values match
  // Make sure the type and value match
  const rvalueName = value_from_value_node(assign.right_value!, status);
  const inferredType = type_from_value_node(assign.right_value!, status);
  if (lvalue && lvalue.type !== inferredType) {
    status.errors.push({
      i: assign.right_value!.i,
      message:
        inferredType === "?"
          ? `Type mismatch -- unknown value type: ${rvalueName}`
          : `Type mismatch: ${inferredType} cannot be assigned to ${lvalue.type} variable`,
    });
  }
}

// FUNCTIONS

function parse_function(status: ParseStatus) {
  const func: FunctionNode = {
    node_type: "func",
    name: "",
    params: [],
    return_type: "",
    children: [],
    i: status.tokens[status.i].i,
  };
  const parent = status.stack.at(-1)!;
  switch (parent.node_type) {
    case "root":
    case "func": {
      parent.children.push(func);
      break;
    }
    case "trait":
    case "struct": {
      (parent as StructNode).functions.push(func);
      break;
    }
    default: {
      status.errors.push({
        message: "Function cannot appear here",
        i: func.i,
      });
      consume(status);
      return;
    }
  }

  status.stack.push(func);
  status.functions.push(func);

  accept("func", status);
  func.name = consume(status);

  if (expect("(", status)) {
    if (peek_current(status) !== ")") {
      parse_function_parameter(func, status);
    }
    if (expect(")", status)) {
      if (accept("->", status)) {
        func.return_type = consume(status);
        if (!check_type_exists(func.return_type, status)) {
          func.return_type = "?";
        }
      }
      // Traits don't need a body, everything else does
      if (
        (parent.node_type === "trait" && accept("{", status)) ||
        expect("{", status)
      ) {
        func.has_body = true;
        parse_statement(status);
        if (expect("}", status)) {
          if (func.return_type && !func.has_return) {
            status.errors.push({
              i: status.tokens[status.i - 1].i,
              message: `Missing return`,
            });
          }
        }
      }
    }
  }

  status.stack.pop();
}

function parse_function_parameter(func: FunctionNode, status: ParseStatus) {
  const param: ParameterNode = {
    node_type: "param",
    name: "",
    type: "",
    children: [],
    i: status.tokens[status.i].i,
  };
  func.params.push(param);

  // Parameter name
  param.name = consume(status);

  // Parameter type
  if (accept(":", status)) {
    param.type = consume(status);
    if (!check_type_exists(param.type, status)) {
      param.type = "?";
    }
  }

  // Parameter value
  if (accept("=", status)) {
    param.default_value = consume(status);
    check_type_and_value_match(
      param.type,
      type_from_value(param.default_value, status),
      param.default_value,
      status,
    );
    param.type = param.type || type_from_value(param.default_value, status);
  }

  // Check type or value has been set
  if (!param.type && !param.default_value) {
    status.errors.push({
      message: `Expected type or default value`,
      i: status.tokens[status.i - 1].i,
    });
  }

  // Next parameter
  if (accept(",", status)) {
    parse_function_parameter(func, status);
  }
}

// FOR LOOP

function parse_for_loop(status: ParseStatus) {
  const for_loop: ForNode = {
    node_type: "for",
    children: [],
    i: status.tokens[status.i].i,
  };
  const parent = status.stack.at(-1)!;
  switch (parent.node_type) {
    case "root":
    case "func": {
      parent.children.push(for_loop);
      break;
    }
    default: {
      status.errors.push({
        message: "For cannot appear here",
        i: for_loop.i,
      });
      consume(status);
      return;
    }
  }

  status.stack.push(for_loop);

  accept("for", status);
  for_loop.item = {
    node_type: "value",
    value: consume(status),
    type: "",
    children: [],
    i: status.tokens[status.i].i,
  } as ValueNode;
  // TODO: index option?
  if (expect("in", status)) {
    for_loop.list = parse_expression(status);
    // HACK: handle array types properly
    for_loop.item.type = type_from_value_node(for_loop.list, status).replace(
      /\[.*\]/,
      "",
    );
    status.values.push({
      declaration: "var",
      name: for_loop.item.value,
      type: for_loop.item.type,
    });
    if (expect("{", status)) {
      parse_statement(status);
      expect("}", status);
    }
  }

  status.stack.pop();
}

// INVOCATION

function parse_invocation_parameter(
  invoke: InvocationNode | AccessInvocationNode,
  status: ParseStatus,
) {
  const param = parse_expression(status);
  invoke.params.push(param);

  // Next parameter
  if (accept(",", status)) {
    parse_invocation_parameter(invoke, status);
  }
}

function check_invocation_node(invoke: InvocationNode, status: ParseStatus) {
  const func = status.functions.find((f) => f.name === invoke.name);
  check_invocation_function(invoke, status, func);
}

function check_invocation_function(
  invoke: InvocationNode | AccessInvocationNode,
  status: ParseStatus,
  func?: FunctionNode,
) {
  // HACK:
  if (func) {
    invoke.type = func.return_type;
  }
  if (!func) {
    status.errors.push({
      message: `Function not found: ${invoke.name}`,
      i: invoke.i,
    });
  } else if (invoke.params.length > func.params.length) {
    status.errors.push({
      message: `Too many parameters for function: ${invoke.name}`,
      i: invoke.i,
    });
  } else if (invoke.params.length < func.params.length) {
    status.errors.push({
      message: `Parameters missing for function: ${invoke.name}`,
      i: invoke.i,
    });
  } else {
    invoke.params.forEach((param, i) => {
      const paramType = func.params[i].type;
      const valueType = type_from_value_node(param, status);
      if (valueType === "?") {
        status.errors.push({
          message: `Type mismatch -- unknown value type: ${value_from_value_node(
            param,
            status,
          )} cannot be used for ${paramType} parameter`,
          i: param.i,
        });
      } else if (valueType !== paramType) {
        status.errors.push({
          message: `Type mismatch: ${valueType} cannot be used for ${paramType} parameter`,
          i: param.i,
        });
      }
    });
  }
}

// RETURN

function parse_return(status: ParseStatus) {
  const ret: ReturnNode = {
    node_type: "ret",
    value: "",
    type: "",
    children: [],
    i: status.tokens[status.i].i,
  };
  status.stack.at(-1)!.children.push(ret);

  // Go up the stack looking for our function
  const func = find_parent_of_type("func", status) as FunctionNode;
  if (func) {
    func.has_return = true;
  } else {
    status.errors.push({
      message: "Return outside function",
      i: status.tokens[status.i].i,
    });
  }

  accept("return", status);
  ret.value = consume(status);
  if (func.return_type && func.return_type !== "?") {
    check_type_and_value_match(
      func.return_type,
      type_from_value(ret.value, status),
      ret.value,
      status,
    );
  }
  ret.type = type_from_value(ret.value, status);
}

// ACCESS

function parse_access(
  source_name: string,
  source_type: string,
  status: ParseStatus,
): AccessFieldNode | AccessInvocationNode {
  const i = status.tokens[status.i].i;
  const name = consume(status);
  const type = type_from_value(name, status);

  if (peek_current(status) === "(") {
    accept("(", status);
    const invoke: AccessInvocationNode = {
      node_type: "accinv",
      name,
      params: [],
      type,
      children: [],
      i,
    };
    // HACK:
    if (invoke.name === "init") {
      invoke.type = source_name;
      invoke.static = true;
    }
    if (peek_current(status) !== ")") {
      parse_invocation_parameter(invoke, status);
    }
    expect(")", status);
    check_access_invocation_node(source_type, invoke, status);
    return invoke;
  } else {
    const field: AccessFieldNode = {
      node_type: "accfld",
      name,
      type,
      children: [],
      i,
    };
    return field;
  }
}

function check_access_invocation_node(
  source_type: string,
  invoke: AccessInvocationNode,
  status: ParseStatus,
) {
  const struct = status.structs.find((s) => s.name === source_type);
  let func = struct?.functions.find((f) => f.name === invoke.name);
  if (!func) {
    const trait = status.traits.find((s) => s.name === source_type);
    func = trait?.functions.find((f) => f.name === invoke.name);
  }
  check_invocation_function(invoke, status, func);
}

// OPERATIONS

function check_operation_node(op: OperationNode, status: ParseStatus) {
  // TODO: Check compatibility of types
  // TODO: Get the type from both sides
  if (op.left_value) {
    const leftType = type_from_value_node(op.left_value, status);
    op.type = leftType;
  }
}

// ARRAY

function parse_array_value(array: ArrayValuesNode, status: ParseStatus) {
  // Get this value
  const value = parse_expression(status);
  array.values.push(value);

  // Maybe get another value
  if (accept(",", status)) {
    parse_array_value(array, status);
  }
}

function check_array_values_node(array: ArrayValuesNode, status: ParseStatus) {
  for (let value of array.values) {
    const type = type_from_value_node(value, status);
    const arrayType = type + `[${array.values.length}]`;
    if (!array.type) {
      array.type = arrayType;
    } else if (array.type !== arrayType) {
      // It might have a trait
      // TOOD: Check this in more places
      const struct = status.structs.find((f) => f.name === type);
      const maybeTrait = array.type.replace(/\[.*\]/, "");
      if (struct?.traits.includes(maybeTrait)) {
        continue;
      }
      /*
      status.errors.push({
        message: `Invalid type: ${type} (expected ${array.type})`,
        i: value.i,
      });*/
    }
  }
}

// PROCESSING

function peek_current(status: ParseStatus): string | undefined {
  return status.tokens[status.i]?.value;
}

function peek_next(status: ParseStatus): string | undefined {
  return status.tokens[status.i + 1]?.value;
}

function consume(status: ParseStatus): string {
  if (status.i < status.tokens.length) {
    const result = status.tokens[status.i].value;
    status.i += 1;
    return result;
  } else {
    const last = status.tokens.at(-1);
    status.errors.push({
      message: "Expected token",
      i: last ? last.i + last.value.length : 0,
    });
    return "";
  }
}

function accept(value: string, status: ParseStatus): boolean {
  if (status.i < status.tokens.length) {
    if (status.tokens[status.i].value == value) {
      status.i += 1;
      return true;
    }
  }
  return false;
}

function expect(value: string, status: ParseStatus): boolean {
  if (status.i < status.tokens.length) {
    if (status.tokens[status.i].value == value) {
      status.i += 1;
      return true;
    } else {
      status.errors.push({
        message: `Expected ${value}`,
        i: status.tokens[status.i].i,
      });
    }
  } else {
    const last = status.tokens.at(-1);
    status.errors.push({
      message: "Expected token",
      i: last ? last.i + last.value.length : 0,
    });
  }
  return false;
}

// UTILS

function type_from_value(value: string, status: ParseStatus): string {
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

function type_from_value_node(node: ParseNode, status: ParseStatus): string {
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
    case "accfld": {
      return (node as AccessFieldNode).type;
    }
    case "accinv": {
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

function value_from_value_node(node: ParseNode, status: ParseStatus): string {
  switch (node.node_type) {
    case "value": {
      return (node as ValueNode).value;
    }
    case "access": {
      return value_from_value_node((node as AccessNode).access, status);
    }
    case "accfld": {
      return (node as AccessFieldNode).name;
    }
  }
  return "?";
}

function check_type_exists(type: string, status: ParseStatus): boolean {
  // Remove array brackets
  type = type.replace(/\[.*\]/, "");
  if (!status.types.includes(type)) {
    status.errors.push({
      i: status.tokens[status.i - 1].i,
      message: `Unknown type: ${type}`,
    });
    return false;
  }
  return true;
}

function check_type_and_value_match(
  target_type: string,
  expression_type: string,
  value: string,
  status: ParseStatus,
) {
  if (target_type) {
    // HACK: Remove array length
    target_type = target_type.replace(/\[.*\]/, "");
    expression_type = expression_type.replace(/\[.*\]/, "");
    // TODO: thorough checking
    if (target_type !== expression_type) {
      // It might be a struct with a matching trait
      // TOOD: Check this in more places
      const struct = status.structs.find((f) => f.name === expression_type);
      if (struct?.traits.includes(target_type)) {
        return;
      }

      status.errors.push({
        i: status.tokens[status.i - 1].i,
        message:
          expression_type === "?"
            ? `Type mismatch -- unknown value type: ${value}`
            : `Type mismatch: ${expression_type} cannot be assigned to ${target_type} variable`,
      });
    }
  } else {
    if (expression_type === "?") {
      status.errors.push({
        i: status.tokens[status.i - 1].i,
        message: `Unknown value type: ${value}`,
      });
    }
  }
}

function find_parent_of_type(
  type: string,
  status: ParseStatus,
): ParseNode | undefined {
  for (let i = status.stack.length - 1; i >= 0; i--) {
    if (status.stack[i].node_type === type) {
      return status.stack[i];
    }
  }
}

function node_name(node: ParseNode) {
  switch (node.node_type) {
    case "declare": {
      return "Declaration";
    }
    case "assign": {
      return "Assignment";
    }
    default: {
      return node.node_type;
    }
  }
}
