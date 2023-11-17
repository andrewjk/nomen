import type ParseNode from "./types/ParseNode";
import type ParseResult from "./types/ParseResult";
import type DeclarationNode from "./types/DeclarationNode";
import type AssignmentNode from "./types/AssignmentNode";
import type ParseError from "./types/ParseError";
import type ParseValue from "./types/ParseValue";

interface Token {
  value: string;
  i: number;
}

interface ParseStatus {
  // The current node
  node: ParseNode;
  // The current token index
  i: number;
  // Values (variables, params, etc) in scope
  values: ParseValue[];
  // Types in scope
  types: string[];
  // Errors that have been encountered
  errors: ParseError[];
}

export default function parse(input: string): ParseResult {
  const root: ParseNode = {
    node_type: "root",
    children: [],
  };

  const status: ParseStatus = {
    node: root,
    i: 0,
    values: [],
    types: ["int", "string"],
    errors: [],
  };

  const tokens = tokenize(input);

  for (status.i; status.i < tokens.length; status.i++) {
    parse_block(tokens, status);
  }

  return {
    ok: !status.errors.length,
    root,
    errors: status.errors,
  };
}

function tokenize(input: string): Token[] {
  let tokens: Token[] = [];
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    if (!is_alpha_numeric_char(input, i)) {
      if (i > start) {
        const value = input.substring(start, i);
        tokens.push({
          value,
          i: i - value.length,
        });
      }
      if (!is_whitespace(input[i])) {
        const value = input[i];
        tokens.push({
          value,
          i: i - value.length,
        });
      }
      start = i + 1;
    }
  }

  return tokens;
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

// DECLARATIONS

function parse_declaration(
  declaration: "const" | "var",
  tokens: Token[],
  status: ParseStatus
) {
  const decl: DeclarationNode = {
    node_type: "dec",
    declaration,
    name: "",
    value: "",
    type: "",
    children: [],
  };
  status.node.children.push(decl);

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
  status: ParseStatus
) {
  if (status.i < tokens.length) {
    decl.name = tokens[status.i].value;
    status.i += 1;
  }
}

function parse_declaration_type(
  decl: DeclarationNode,
  tokens: Token[],
  status: ParseStatus
) {
  if (status.i < tokens.length) {
    if (tokens[status.i].value == ":") {
      status.i += 1;
      if (status.i < tokens.length) {
        decl.type = tokens[status.i].value;

        // Make sure the type exists
        if (!status.types.includes(decl.type)) {
          status.errors.push({
            i: tokens[status.i].i,
            message: `Unknown type: ${decl.type}`,
          });
        }

        status.i += 1;
      }
    }
  }
}

function parse_declaration_value(
  decl: DeclarationNode,
  tokens: Token[],
  status: ParseStatus
) {
  if (status.i < tokens.length) {
    if (tokens[status.i].value == "=") {
      status.i += 1;
      if (status.i < tokens.length) {
        decl.value = tokens[status.i].value;

        // Make sure the type and value match
        const inferredType = type_from_value(decl.value);
        if (decl.type) {
          // TODO: thorough checking
          if (decl.type !== inferredType) {
            status.errors.push({
              i: tokens[status.i].i,
              message:
                inferredType === "?"
                  ? `Type mismatch -- unknown value type: ${decl.value}`
                  : `Type mismatch: ${inferredType} cannot be assigned to ${decl.type} variable`,
            });
          }
        } else {
          if (inferredType === "?") {
            status.errors.push({
              i: tokens[status.i].i,
              message: `Unknown value type: ${decl.value}`,
            });
          }
          decl.type = inferredType;
        }

        status.i += 1;
      }
    }
  }
}

// ASSIGNMENTS

function parse_assignment(tokens: Token[], status: ParseStatus) {
  const ass: AssignmentNode = {
    node_type: "ass",
    left_value: "",
    right_value: "",
    children: [],
  };
  status.node.children.push(ass);

  parse_assignment_left_value(ass, tokens, status);

  // Advance past the equals sign
  status.i += 1;

  parse_assignment_right_value(ass, tokens, status);

  // HACK: Decrement for the loop
  status.i -= 1;
}

function parse_assignment_left_value(
  ass: AssignmentNode,
  tokens: Token[],
  status: ParseStatus
) {
  if (status.i < tokens.length) {
    ass.left_value = tokens[status.i].value;

    // Make sure the left value exists and can be assigned to
    const value = status.values.find((v) => v.name === ass.left_value);
    if (!value) {
      status.errors.push({
        i: tokens[status.i].i,
        message: `Unknown variable: ${ass.left_value}`,
      });
    } else if (value.declaration === "const") {
      status.errors.push({
        i: tokens[status.i].i,
        message: `Assignment to const: ${ass.left_value}`,
      });
    }

    status.i += 1;
  }
}

function parse_assignment_right_value(
  ass: AssignmentNode,
  tokens: Token[],
  status: ParseStatus
) {
  if (status.i < tokens.length) {
    ass.right_value = tokens[status.i].value;

    // Make sure the types of the left and right values match
    // Make sure the type and value match
    const value = status.values.find((v) => v.name === ass.left_value);
    const inferredType = type_from_value(ass.right_value);
    if (value && value.type !== inferredType) {
      status.errors.push({
        i: tokens[status.i].i,
        message:
          inferredType === "?"
            ? `Type mismatch -- unknown value type: ${ass.right_value}`
            : `Type mismatch: ${inferredType} cannot be assigned to ${value.type} variable`,
      });
    }

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

function is_alpha_numeric(input: string) {
  for (let i = 0; i < input.length; i++) {
    if (!is_alpha_numeric_char(input, i)) {
      return false;
    }
  }
  return true;
}

function is_alpha_numeric_char(input: string, i: number) {
  let code = input.charCodeAt(i);
  return (
    // 0-9
    (code > 47 && code < 58) ||
    // A-Z
    (code > 64 && code < 91) ||
    // a-z
    (code > 96 && code < 123)
  );
}

function is_whitespace(text: string) {
  return text === " " || text === "\t" || text === "\r" || text === "\n";
}
