import BaseNode from "../nodes/BaseNode";
import type CompileError from "../types/CompileError";
import type Token from "../types/Token";

export default interface ParseStatus {
  // The tokens
  tokens: Token[];
  // The current token index
  i: number;
  // The current node
  stack: BaseNode[];
  // Errors that have been encountered
  errors: CompileError[];
}
