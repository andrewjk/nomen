import Token from "./types/Token";

enum CharType {
  AlphaNumeric,
  Symbol,
  Space,
}

export default function tokenize(input: string): Token[] {
  let tokens: Token[] = [];
  let start = 0;
  let charType = CharType.Space;

  for (let i = 0; i < input.length; i++) {
    let char = input[i];

    // If the char type has changed, add a token
    // Skip whitespace though, it doesn't interest us
    // TODO: Unless it's a newline
    const newCharType = is_alpha_numeric_char(input, i)
      ? CharType.AlphaNumeric
      : is_whitespace_char(input, i)
      ? CharType.Space
      : CharType.Symbol;
    if (i > start && newCharType !== charType) {
      const value = input.substring(start, i);
      if (charType != CharType.Space) {
        tokens.push({ value, i: start });
      }
      start = i;
    }
    charType = newCharType;

    // Just pull strings and comments into tokens
    if (char === '"') {
      // It's a string -- process until the next quote
      for (let j = i + 1; j < input.length; j++) {
        if (input[j] === '"' && input[j - 1] !== "\\") {
          const value = input.substring(i, j + 1);
          tokens.push({ value, i });
          i = j;
          start = i + 1;
          break;
        }
      }
    } else if (char === "/") {
      if (i < input.length - 2 && input[i + 1] === "/") {
        // It's a one-line comment -- process until the newline
        for (let j = i + 1; j < input.length; j++) {
          if (input[j] === "\n") {
            const value = input.substring(i, j);
            tokens.push({ value, i });
            i = j;
            start = i + 1;
            break;
          }
        }
      } else if (i < input.length - 2 && input[i + 1] === "*") {
        // It's a multi-line comment -- process until the close, handling nested comments
        let depth = 0;
        for (let j = i + 1; j < input.length; j++) {
          if (
            input[j] === "/" &&
            j < input.length - 2 &&
            input[j + 1] === "*"
          ) {
            depth += 1;
          } else if (input[j] === "/" && input[j - 1] === "*") {
            if (depth > 0) {
              depth -= 1;
            } else {
              let value = input.substring(i, j + 1);
              tokens.push({ value, i });
              i = j;
              start = i + 1;
              break;
            }
          }
        }
      }
    }
  }

  return tokens;
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
