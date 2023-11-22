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
  // The current node
  stack: ParseNode[];
  // The current token index
  i: number;
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
    stack: [root],
    i: 0,
    values: [],
    types: ["int", "string"],
    errors: [],
  };

  for (status.i; status.i < tokens.length; status.i++) {
    parse_block(tokens, status);
  }

  return {
    ok: !status.errors.length,
    root,
    errors: status.errors,
  };
}

function parse_block(tokens: Token[], status: ParseStatus) {
  for (status.i; status.i < tokens.length; status.i++) {
    // First check for a keyword (var, if, switch, etc), then check for a following operator (=, +, etc)
    const value = tokens[status.i].value;
    switch (value) {
      case "const":
      case "var": {
        parse_declaration(value, tokens, status);
        break;
      }
      case "func": {
        parse_function(tokens, status);
        break;
      }
      case "return": {
        parse_return(tokens, status);
        break;
      }
      case "}": {
        return;
      }
      default: {
        if (status.i < tokens.length - 1) {
          const nextValue = tokens[status.i + 1].value;
          switch (nextValue) {
            case "=": {
              parse_assignment(tokens, status);
              break;
            }
          }
        }
      }
    }
  }
}

// DECLARATION

function parse_declaration(
  declaration: "const" | "var",
  tokens: Token[],
  status: ParseStatus,
) {
  const decl: DeclarationNode = {
    node_type: "decl",
    declaration,
    name: "",
    value: "",
    type: "",
    children: [],
  };
  status.stack.at(-1)!.children.push(decl);

  // Advance past the keyword
  status.i += 1;

  // Parse the declaration
  parse_declaration_name(decl, tokens, status);
  parse_declaration_type(decl, tokens, status);
  parse_declaration_value(decl, tokens, status);

  // Add a new value to the stack
  status.values.push({
    declaration: decl.declaration,
    name: decl.name,
    type: decl.type,
  });

  // HACK: Decrement for the loop
  status.i -= 1;
}

function parse_declaration_name(
  decl: DeclarationNode,
  tokens: Token[],
  status: ParseStatus,
) {
  if (status.i < tokens.length) {
    decl.name = tokens[status.i].value;
    status.i += 1;
  }
}

function parse_declaration_type(
  decl: DeclarationNode,
  tokens: Token[],
  status: ParseStatus,
) {
  if (status.i < tokens.length) {
    if (tokens[status.i].value == ":") {
      status.i += 1;
      if (status.i < tokens.length) {
        decl.type = tokens[status.i].value;
        if (!check_type_exists(decl.type, tokens, status)) {
          decl.type = "?";
        }
        status.i += 1;
      }
    }
  }
}

function parse_declaration_value(
  decl: DeclarationNode,
  tokens: Token[],
  status: ParseStatus,
) {
  if (status.i < tokens.length) {
    if (tokens[status.i].value == "=") {
      status.i += 1;
      if (status.i < tokens.length) {
        decl.value = tokens[status.i].value;
        check_type_and_value_match(decl.type, decl.value, status, tokens);
        decl.type = decl.type || type_from_value(decl.value);
        status.i += 1;
      }
    }
  }
}

// ASSIGNMENT

function parse_assignment(tokens: Token[], status: ParseStatus) {
  const assign: AssignmentNode = {
    node_type: "assign",
    left_value: "",
    right_value: "",
    children: [],
  };
  status.stack.at(-1)!.children.push(assign);

  parse_assignment_left_value(assign, tokens, status);

  // Advance past the equals sign
  status.i += 1;

  parse_assignment_right_value(assign, tokens, status);

  // HACK: Decrement for the loop
  status.i -= 1;
}

function parse_assignment_left_value(
  assign: AssignmentNode,
  tokens: Token[],
  status: ParseStatus,
) {
  if (status.i < tokens.length) {
    assign.left_value = tokens[status.i].value;

    // Make sure the left value exists and can be assigned to
    const value = status.values.find((v) => v.name === assign.left_value);
    if (!value) {
      status.errors.push({
        i: tokens[status.i].i,
        message: `Unknown variable: ${assign.left_value}`,
      });
    } else if (value.declaration === "const") {
      status.errors.push({
        i: tokens[status.i].i,
        message: `Assignment to const: ${assign.left_value}`,
      });
    }

    status.i += 1;
  }
}

function parse_assignment_right_value(
  assign: AssignmentNode,
  tokens: Token[],
  status: ParseStatus,
) {
  if (status.i < tokens.length) {
    assign.right_value = tokens[status.i].value;

    // Make sure the types of the left and right values match
    // Make sure the type and value match
    const value = status.values.find((v) => v.name === assign.left_value);
    const inferredType = type_from_value(assign.right_value);
    if (value && value.type !== inferredType) {
      status.errors.push({
        i: tokens[status.i].i,
        message:
          inferredType === "?"
            ? `Type mismatch -- unknown value type: ${assign.right_value}`
            : `Type mismatch: ${inferredType} cannot be assigned to ${value.type} variable`,
      });
    }

    status.i += 1;
  }
}

// FUNCTIONS

function parse_function(tokens: Token[], status: ParseStatus) {
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

  // Advance past the keyword
  status.i += 1;

  // Parse the function
  parse_function_name(func, tokens, status);

  if (tokens[status.i].value === "(") {
    // Advance past the opening paren
    status.i += 1;

    if (tokens[status.i].value !== ")") {
      parse_parameter(func, tokens, status);
    }

    if (tokens[status.i].value === ")") {
      // Advance past the closing paren
      status.i += 1;

      parse_function_return_type(func, tokens, status);
      if (tokens[status.i].value === "{") {
        // TODO:
        status.i += 1;
        parse_block(tokens, status);

        if (tokens[status.i].value === "}") {
          if (func.return_type && !func.has_return) {
            status.errors.push({
              i: tokens[status.i].i,
              message: `Missing return`,
            });
          }
          status.i += 1;
        } else {
          status.errors.push({
            i: tokens[status.i].i,
            message: `Expected '}'`,
          });
        }
      } else {
        status.errors.push({
          i: tokens[status.i].i,
          message: `Expected '{'`,
        });
      }
    } else {
      status.errors.push({
        i: tokens[status.i].i,
        message: `Expected ')'`,
      });
    }
  } else {
    status.errors.push({
      i: tokens[status.i].i,
      message: `Expected '('`,
    });
  }

  // HACK: Decrement for the loop
  status.i -= 1;
  status.stack.pop();
}

function parse_function_name(
  func: FunctionNode,
  tokens: Token[],
  status: ParseStatus,
) {
  if (status.i < tokens.length) {
    func.name = tokens[status.i].value;
    status.i += 1;
  }
}

function parse_parameter(
  func: FunctionNode,
  tokens: Token[],
  status: ParseStatus,
) {
  const param: ParameterNode = {
    node_type: "param",
    name: "",
    type: "",
    default_value: "",
    children: [],
  };
  func.params.push(param);

  parse_parameter_name(param, tokens, status);
  parse_parameter_type(param, tokens, status);
  parse_parameter_value(param, tokens, status);

  if (status.i < tokens.length && tokens[status.i].value === ",") {
    status.i += 1;
    parse_parameter(func, tokens, status);
  }
}

function parse_parameter_name(
  param: ParameterNode,
  tokens: Token[],
  status: ParseStatus,
) {
  if (status.i < tokens.length) {
    param.name = tokens[status.i].value;
    status.i += 1;
  }
}

function parse_parameter_type(
  param: ParameterNode,
  tokens: Token[],
  status: ParseStatus,
) {
  if (status.i < tokens.length) {
    if (tokens[status.i].value == ":") {
      status.i += 1;
      if (status.i < tokens.length) {
        param.type = tokens[status.i].value;
        if (!check_type_exists(param.type, tokens, status)) {
          param.type = "?";
        }
        status.i += 1;
      }
    }
  }
}

function parse_parameter_value(
  param: ParameterNode,
  tokens: Token[],
  status: ParseStatus,
) {
  if (status.i < tokens.length) {
    if (tokens[status.i].value == "=") {
      status.i += 1;
      if (status.i < tokens.length) {
        param.default_value = tokens[status.i].value;
        check_type_and_value_match(
          param.type,
          param.default_value,
          status,
          tokens,
        );
        param.type = param.type || type_from_value(param.default_value);
        status.i += 1;
      }
    }
  }
}

function parse_function_return_type(
  func: FunctionNode,
  tokens: Token[],
  status: ParseStatus,
) {
  if (status.i < tokens.length) {
    if (tokens[status.i].value == "->") {
      status.i += 1;
      if (status.i < tokens.length) {
        func.return_type = tokens[status.i].value;
        if (!check_type_exists(func.return_type, tokens, status)) {
          func.return_type = "?";
        }
        status.i += 1;
      }
    }
  }
}

// RETURN

function parse_return(tokens: Token[], status: ParseStatus) {
  const ret: ReturnNode = {
    node_type: "ret",
    value: "",
    type: "",
    children: [],
  };
  status.stack.at(-1)!.children.push(ret);

  // Go up the stack looking for our function
  const func = find_parent_of_type("func", status) as FunctionNode;
  if (!func) {
    status.errors.push({
      message: "Return outside function",
      i: tokens[status.i].i,
    });
  }
  func.has_return = true;

  // Advance past the keyword
  status.i += 1;

  // Parse the function
  parse_return_value(func, ret, tokens, status);

  // HACK: Decrement for the loop
  status.i -= 1;
}

function parse_return_value(
  func: FunctionNode,
  ret: ReturnNode,
  tokens: Token[],
  status: ParseStatus,
) {
  if (status.i < tokens.length) {
    ret.value = tokens[status.i].value;
    if (func.return_type && func.return_type !== "?") {
      check_type_and_value_match(func.return_type, ret.value, status, tokens);
    }
    ret.type = type_from_value(ret.value);
    status.i += 1;
  }
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

function check_type_exists(
  type: string,
  tokens: Token[],
  status: ParseStatus,
): boolean {
  if (!status.types.includes(type)) {
    status.errors.push({
      i: tokens[status.i].i,
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
  tokens: Token[],
) {
  const inferredType = type_from_value(value);
  if (type) {
    // TODO: thorough checking
    if (type !== inferredType) {
      status.errors.push({
        i: tokens[status.i].i,
        message:
          inferredType === "?"
            ? `Type mismatch -- unknown value type: ${value}`
            : `Type mismatch: ${inferredType} cannot be assigned to ${type} variable`,
      });
    }
  } else {
    if (inferredType === "?") {
      status.errors.push({
        i: tokens[status.i].i,
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
