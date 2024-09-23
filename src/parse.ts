import check from "./check";
import RootNode from "./nodes/RootNode";
import type ParseStatus from "./parse/ParseStatus";
import parse_statement from "./parse/parse_statement";
import tokenize from "./tokenize";
import type ParseResult from "./types/ParseResult";

export default function parse(input: string): ParseResult {
  const tokens = tokenize(input);

  const root = new RootNode();

  const status: ParseStatus = {
    tokens,
    i: 0,
    stack: [root],
    errors: [],
  };

  parse_statement(status);

  const checked = check(root);
  const errors = status.errors.concat(checked.errors).sort((a, b) => a.start - b.start);

  return {
    ok: !errors.length,
    root,
    errors,
  };
}
