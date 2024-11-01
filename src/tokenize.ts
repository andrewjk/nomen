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

interface TokenizeStatus {
  i: number;
  start: number;
  tokens: Token[];
}

export default function tokenize(input: string, preserve_space = false): Token[] {
  let status: TokenizeStatus = {
    i: 0,
    start: 0,
    tokens: [],
  };

  for (status.i = 0; status.i < input.length; status.i++) {
    if (!is_word_char(input, status.i)) {
      // Add the previous word
      if (status.i > status.start) {
        let value = input.substring(status.start, status.i);

        if (is_number(value) && input[status.i] === "." && is_number(input[status.i + 1])) {
          // It's a float, include the decimal part
          for (let j = status.i + 2; j < input.length; j++) {
            if (!is_number_char(input, j)) {
              value = input.substring(status.start, j);
              status.i = j - 1;
              break;
            }
          }
        }

        status.tokens.push({ value, i: status.start });
      }

      // Add the current symbol (and potentially a little more)
      if (is_whitespace(input[status.i])) {
        if (preserve_space) {
          let value = input[status.i];
          status.tokens.push({ value, i: status.start });
        }
      } else {
        let value = input[status.i];
        if (value === '"') {
          // It's a string -- process until the next quote, including interpolations
          let end = consume_string(input, status);
          value = input.substring(status.i, end);
          status.i = end - 1;
        } else if (value === "/" && input[status.i + 1] === "/") {
          // It's a one-line comment -- process until the newline
          let end = consume_comment(input, status);
          value = input.substring(status.i, end);
          status.i = end - 1;
        } else if (value === "/" && input[status.i + 1] === "*") {
          // It's a block comment -- process until the close, handling nested comments
          let end = consume_block_comment(input, status);
          value = input.substring(status.i, end);
          status.i = end - 1;
        } else if (COMPOUND_SYMBOLS.includes(value + input[status.i + 1])) {
          // It's a compound symbol
          value = value + input[status.i + 1];
          status.i += 1;
        } else if (value === "+" || value === "-") {
          // It might be a sign, include any numbers afterwards
          for (let j = status.i + 1; j < input.length; j++) {
            if (!is_number_char(input, j)) {
              value = input.substring(status.i, j);
              status.i = j - 1;
              break;
            }
          }
        } else if (value === "`" && input.substring(status.i, status.i + 3) === "```") {
          // It's raw C code -- process until the next ```
          for (let j = status.i + 1; j < input.length; j++) {
            if (input[j] === "`" && input.substring(j, j + 3) === "```") {
              value = input.substring(status.i + 3, j);
              status.i = j + 3;
              break;
            }
          }
          // Pop a "raw" token before the value so we can find it when parsing
          status.tokens.push({ value: "raw", i: status.start });
        }
        status.tokens.push({ value, i: status.start });
      }
      status.start = status.i + 1;
    }
  }

  // Add the last word
  if (input.length > status.start) {
    const value = input.substring(status.start, input.length);
    if (!!value.trim()) {
      status.tokens.push({ value, i: status.start });
    }
  }

  return status.tokens;
}

function consume_string(input: string, status: TokenizeStatus) {
  for (let j = status.i + 1; j < input.length; j++) {
    if (input[j] === "\\" && input[j + 1] === "{") {
      status.tokens.push({ value: input.substring(status.i, j), i: status.i });
      status.i = j;
      status.tokens.push({ value: "\\{", i: status.i });
      let end = consume_interpolated_expression(input, status.i);
      let fragment = input.substring(status.i + 2, end);
      status.i = status.i + 2;
      for (let subtoken of tokenize(fragment)) {
        subtoken.i += status.i;
        status.tokens.push(subtoken);
      }
      status.i = end;
      status.tokens.push({ value: "}", i: status.i });
      status.i = status.i + 1;
    } else if (input[j] === '"' && input[j - 1] !== "\\") {
      return j + 1;
    }
  }
  return input.length - 1;
}

function consume_interpolated_expression(input: string, i: number) {
  let depth = 0;
  for (let j = i; j < input.length; j++) {
    if (input[j] === "{") {
      depth += 1;
    } else if (input[j] === "}") {
      depth -= 1;
      if (depth === 0) {
        return j;
      }
    }
  }
  return input.length - 1;
}

function consume_comment(input: string, status: TokenizeStatus) {
  for (let j = status.i + 1; j < input.length; j++) {
    if (input[j] === "\n") {
      return j;
    }
  }
  return input.length - 1;
}

function consume_block_comment(input: string, status: TokenizeStatus) {
  let depth = 0;
  for (let j = status.i; j < input.length; j++) {
    if (input[j] === "/" && input[j + 1] === "*") {
      depth += 1;
    } else if (input[j] === "*" && input[j + 1] === "/") {
      depth -= 1;
      if (depth === 0) {
        return j + 2;
      }
    }
  }
  return input.length - 1;
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

function is_number(input: string) {
  for (let i = 0; i < input.length; i++) {
    if (!is_number_char(input, i)) {
      return false;
    }
  }
  return true;
}

function is_number_char(input: string, i: number) {
  let code = input.charCodeAt(i);
  return (
    // 0-9
    (code > 47 && code < 58) || code === 95
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
