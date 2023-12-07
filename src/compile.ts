import build from "./build";
import check from "./check";
import parse from "./parse";
import tokenize from "./tokenize";
import type CompileResult from "./types/CompileResult";

export default function compile(input: string): CompileResult {
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  if (!parsed.ok || !checked.ok) {
    return {
      ok: false,
      headers: "",
      code: "",
      errors: parsed.errors.concat(checked.errors),
    };
  }
  const result = build(parsed.root);
  return {
    ok: true,
    headers: result.headers,
    code: result.code,
    errors: [],
  };
}
