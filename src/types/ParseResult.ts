import RootNode from "../nodes/RootNode.ts";
import type CompileError from "./CompileError.ts";

export default interface ParseResult {
  ok: boolean;
  root: RootNode;
  errors: CompileError[];
}
