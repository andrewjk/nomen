import RootNode from "../nodes/RootNode";
import type CompileError from "./CompileError";

export default interface ParseResult {
  ok: boolean;
  root: RootNode;
  errors: CompileError[];
}
