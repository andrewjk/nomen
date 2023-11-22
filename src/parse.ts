import type AssignmentNode from "./types/AssignmentNode";
import type DeclarationNode from "./types/DeclarationNode";
import type FunctionNode from "./types/FunctionNode";
import type ParameterNode from "./types/ParameterNode";
import type ParseError from "./types/ParseError";
import type ParseNode from "./types/ParseNode";
import type ParseResult from "./types/ParseResult";
import type ParseValue from "./types/ParseValue";
import type ReturnNode from "./types/ReturnNode";
import type Token from "./types/Token";

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
  // Errors that have been encountered
  errors: ParseError[];
}

export default function parse(tokens: Token[]): ParseResult {
  const root: ParseNode = {
    node_type: "root",
    children: [],
  };

  const status: ParseStatus = {
    tokens,
    i: 0,
    stack: [root],
    values: [],
    types: ["int", "string"],
    errors: [],
  };

  parse_block(status);

  return {
    ok: !status.errors.length,
    root,
    errors: status.errors,
  };
}

function parse_block(status: ParseStatus) {
  while (true) {
    const value = peek_current(status);
    if (!value) {
      break;
    }

    // First check for a keyword (var, if, switch, etc), then check for a following operator (=, +, etc)
    switch (value) {
      case "const":
      case "var": {
        parse_declaration(value, status);
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
        const next_value = peek_next(status);
        switch (next_value) {
          case "=": {
            parse_assignment(status);
            break;
          }
          default: {
            // TODO: ??
            break;
          }
        }
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
    value: "",
    type: "",
    children: [],
  };
  status.stack.at(-1)!.children.push(decl);

  accept(declaration, status);

  // Declaration name
  decl.name = consume(status);

  // Declaration type
  if (accept(":", status)) {
    decl.type = consume(status);
    if (!check_type_exists(decl.type, status)) {
      decl.type = "?";
    }
  }

  // Declaration value
  if (accept("=", status)) {
    decl.value = consume(status);
    check_type_and_value_match(decl.type, decl.value, status);
    decl.type = decl.type || type_from_value(decl.value);
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

// ASSIGNMENT

function parse_assignment(status: ParseStatus) {
  const assign: AssignmentNode = {
    node_type: "assign",
    left_value: "",
    right_value: "",
    children: [],
  };
  status.stack.at(-1)!.children.push(assign);

  assign.left_value = consume(status);

  // Make sure the left value exists and can be assigned to
  const lvalue = status.values.find((v) => v.name === assign.left_value);
  if (!lvalue) {
    status.errors.push({
      i: status.tokens[status.i - 1].i,
      message: `Unknown variable: ${assign.left_value}`,
    });
  } else if (lvalue.declaration === "const") {
    status.errors.push({
      i: status.tokens[status.i - 1].i,
      message: `Assignment to const: ${assign.left_value}`,
    });
  }

  expect("=", status);

  assign.right_value = consume(status);

  // Make sure the types of the left and right values match
  // Make sure the type and value match
  const rvalue = status.values.find((v) => v.name === assign.left_value);
  const inferredType = type_from_value(assign.right_value);
  if (rvalue && rvalue.type !== inferredType) {
    status.errors.push({
      i: status.tokens[status.i - 1].i,
      message:
        inferredType === "?"
          ? `Type mismatch -- unknown value type: ${assign.right_value}`
          : `Type mismatch: ${inferredType} cannot be assigned to ${rvalue.type} variable`,
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
  };
  status.stack.at(-1)!.children.push(func);
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
      if (expect("{", status)) {
        parse_block(status);
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
    check_type_and_value_match(param.type, param.default_value, status);
    param.type = param.type || type_from_value(param.default_value);
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
    check_type_and_value_match(func.return_type, ret.value, status);
  }
  ret.type = type_from_value(ret.value);
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

function type_from_value(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return "string";
  } else if (/^\d+$/.test(value)) {
    return "int";
  } else {
    return "?";
  }
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
  type: string,
  value: string,
  status: ParseStatus,
) {
  const inferredType = type_from_value(value);
  if (type) {
    // TODO: thorough checking
    if (type !== inferredType) {
      status.errors.push({
        i: status.tokens[status.i - 1].i,
        message:
          inferredType === "?"
            ? `Type mismatch -- unknown value type: ${value}`
            : `Type mismatch: ${inferredType} cannot be assigned to ${type} variable`,
      });
    }
  } else {
    if (inferredType === "?") {
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
