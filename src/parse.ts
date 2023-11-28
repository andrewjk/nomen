import type AccessNode from "./types/AccessNode";
import type AssignmentNode from "./types/AssignmentNode";
import type DeclarationNode from "./types/DeclarationNode";
import type FieldAccessNode from "./types/FieldAccessNode";
import type FunctionNode from "./types/FunctionNode";
import type ParameterNode from "./types/ParameterNode";
import type ParseError from "./types/ParseError";
import type ParseNode from "./types/ParseNode";
import type ParseResult from "./types/ParseResult";
import type ParseValue from "./types/ParseValue";
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
  // Values (variables, params, etc) in scope
  values: ParseValue[];
  // Types in scope
  types: string[];
  // Structs and traits
  // TODO: Scope these!
  structs: StructNode[];
  traits: TraitNode[];
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
          access: parse_access(status),
          children: [],
          i: node.i,
        };
        node = access;
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
          case "func": {
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
          access: parse_access(status),
          children: [],
          i: node.i,
        };
        node = access;
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
    has_return: false,
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

  accept("func", status);
  func.name = consume(status);

  if (expect("(", status)) {
    if (peek_current(status) !== ")") {
      parse_parameter(func, status);
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

function parse_parameter(func: FunctionNode, status: ParseStatus) {
  const param: ParameterNode = {
    node_type: "param",
    name: "",
    type: "",
    default_value: "",
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
    parse_parameter(func, status);
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

function parse_access(status: ParseStatus): FieldAccessNode {
  const i = status.tokens[status.i].i;
  const name = consume(status);
  const type = type_from_value(name, status);
  const field: FieldAccessNode = {
    node_type: "field",
    name,
    type,
    children: [],
    i,
  };
  return field;
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
    case "field": {
      return (node as FieldAccessNode).type;
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
    case "field": {
      return (node as FieldAccessNode).name;
    }
  }
  return "?";
}

function check_type_exists(type: string, status: ParseStatus): boolean {
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
    // TODO: thorough checking
    if (target_type !== expression_type) {
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
