import type CompileError from "./CompileError";
import type RootNode from "./RootNode";

export default interface ParseResult {
  ok: boolean;
  root: RootNode;
  errors: CompileError[];
}
