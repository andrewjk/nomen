import type ParseNode from "./types/ParseNode";
import type ParseResult from "./types/ParseResult";
import type DeclarationNode from "./types/DeclarationNode";
import type ParseError from "./types/ParseError";

interface Token {
  value: string;
  i: number;
}

interface ParseStatus {
  node: ParseNode;
  i: number;
  errors: ParseError[];
}

export default function parse(input: string): ParseResult {
  const root: ParseNode = {
    nodetype: "root",
    children: [],
  };

  const status: ParseStatus = {
    node: root,
    i: 0,
    errors: [],
  };

  const tokens = tokenize(input);

  for (status.i; status.i < tokens.length; status.i++) {
    parseBlock(tokens, status);
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
    if (!isAlphaNumericChar(input, i)) {
      if (i > start) {
        const value = input.substring(start, i);
        tokens.push({
          value,
          i: i - value.length,
        });
      }
      if (!isWhitespace(input[i])) {
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

function parseBlock(tokens: Token[], status: ParseStatus) {
  for (status.i; status.i < tokens.length - 1; status.i++) {
    const value = tokens[status.i].value;
    switch (value) {
      case "const":
      case "var": {
        parseDeclaration(value, tokens, status);
      }
    }
  }
}

function parseDeclaration(
  declaration: "const" | "var",
  tokens: Token[],
  status: ParseStatus
) {
  const decl: DeclarationNode = {
    nodetype: "decl",
    declaration,
    name: "",
    value: "",
    type: "",
    children: [],
  };

  status.i++;

  parseDeclarationName(decl, tokens, status);
  parseDeclarationType(decl, tokens, status);
  parseDeclarationValue(decl, tokens, status);

  status.node.children.push(decl);
  status.node = decl;
}

function parseDeclarationName(
  decl: DeclarationNode,
  tokens: Token[],
  status: ParseStatus
) {
  if (status.i < tokens.length) {
    decl.name = tokens[status.i].value;
    status.i += 1;
  }
}

function parseDeclarationType(
  decl: DeclarationNode,
  tokens: Token[],
  status: ParseStatus
) {
  if (status.i < tokens.length) {
    if (tokens[status.i].value == ":") {
      status.i += 1;
      if (status.i < tokens.length) {
        decl.type = tokens[status.i].value;
        if (!checkType(decl.type)) {
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

function parseDeclarationValue(
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
        const inferredType = typeFromValue(decl.value);
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

function typeFromValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return "string";
  } else if (value.match(/$\d+^/)) {
    return "int";
  } else {
    return "?";
  }
}

function checkType(type: string): boolean {
  switch (type) {
    case "int":
    case "string": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function isAlphaNumeric(input: string) {
  for (let i = 0; i < input.length; i++) {
    if (!isAlphaNumericChar(input, i)) {
      return false;
    }
  }
  return true;
}

function isAlphaNumericChar(input: string, i: number) {
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

function isWhitespace(text: string) {
  return text === " " || text === "\t" || text === "\r" || text === "\n";
}
