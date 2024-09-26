import type Token from "./types/Token";

const COMPOUND_SYMBOLS = [
  // Relational
  "==",
  "!=",
  ">=",
  "<=",
  // Bitwise
  ">>",
  "<<",
  // Logical
  "&&",
  "||",
  // Assignment
  "+=",
  "-=",
  // Range
  "..",
  ".=",
  // Type
  "->",
  "=>",
];

export default function tokenize(input: string): Token[] {
  let tokens: Token[] = [];
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    if (!is_word_char(input, i)) {
      // Add the previous word
      if (i > start) {
        const value = input.substring(start, i);
        tokens.push({ value, i: start });
      }

      // Add the current symbol (and potentially a little more)
      if (!is_whitespace(input[i])) {
        let value = input[i];
        if (value === '"') {
          // It's a string -- process until the next quote
          for (let j = i + 1; j < input.length; j++) {
            if (input[j] === '"' && input[j - 1] !== "\\") {
              value = input.substring(i, j + 1);
              i = j;
              break;
            }
          }
        } else if (value === "/" && i < input.length - 2) {
          if (input[i + 1] === "/") {
            // It's a one-line comment -- process until the newline
            for (let j = i + 1; j < input.length; j++) {
              if (input[j] === "\n") {
                value = input.substring(i, j);
                i = j;
                break;
              }
            }
          } else if (input[i + 1] === "*") {
            // It's a multi-line comment -- process until the close, handling nested comments
            let depth = 0;
            for (let j = i + 1; j < input.length; j++) {
              if (input[j] === "/" && j < input.length - 2 && input[j + 1] === "*") {
                depth += 1;
              } else if (input[j] === "/" && input[j - 1] === "*") {
                if (depth > 0) {
                  depth -= 1;
                } else {
                  value = input.substring(i, j + 1);
                  i = j;
                  break;
                }
              }
            }
          }
        } else if (i < input.length - 2 && COMPOUND_SYMBOLS.includes(value + input[i + 1])) {
          // It's a compound symbol
          value = value + input[i + 1];
          i += 1;
        }
        tokens.push({ value, i: start });
      }
      start = i + 1;
    }
  }

  return tokens;
}

function is_word(input: string) {
  for (let i = 0; i < input.length; i++) {
    if (!is_word_char(input, i)) {
      return false;
    }
  }
  return true;
}

function is_word_char(input: string, i: number) {
  let code = input.charCodeAt(i);
  return (
    // 0-9
    (code > 47 && code < 58) ||
    // A-Z
    (code > 64 && code < 91) ||
    // a-z
    (code > 96 && code < 123) ||
    // _
    code === 95
  );
}

function is_whitespace(input: string) {
  for (let i = 0; i < input.length; i++) {
    if (!is_whitespace_char(input, i)) {
      return false;
    }
  }
  return true;
}

function is_whitespace_char(input: string, i: number) {
  let code = input.charCodeAt(i);
  return code === 32 || (code >= 9 && code <= 13);
}
