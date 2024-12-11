import check from "./check";
import RootNode from "./nodes/RootNode";
import type ParseStatus from "./parse/ParseStatus";
import parse_statement from "./parse/parse_statement";
import tokenize from "./tokenize";
import type ParseResult from "./types/ParseResult";

export default function parse(source: string): ParseResult {
  const tokens = tokenize(source);

  const root = new RootNode();

  const status: ParseStatus = {
    tokens,
    i: 0,
    stack: [root],
    // TODO: Should be the base namespace, from module.config, folder structure, file name
    namespace: "",
    errors: [],
  };

  parse_statement(status);

  const checked = check(root);
  const errors = status.errors.concat(checked.errors).sort((a, b) => a.start - b.start);

  // Add line and column information to errors
  let line = 1;
  let lastLineStart = 0;
  for (let i = 0, e = 0; i < source.length, e < errors.length; i++) {
    if (source[i] === "\n") {
      line += 1;
      lastLineStart = i + 1;
    }
    while (e < errors.length && errors[e].start === i) {
      errors[e].line = line;
      errors[e].column = i - lastLineStart + 1;
      e += 1;
    }
  }

  return {
    ok: !errors.length,
    root,
    errors,
  };
}
