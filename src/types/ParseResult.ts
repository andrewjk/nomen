import type CompileError from "./CompileError";
import type ParseNode from "./ParseNode";

export default interface ParseResult {
  ok: boolean;
  root: ParseNode;
  errors: CompileError[];
}
