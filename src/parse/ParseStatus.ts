import BaseNode from "../nodes/BaseNode.ts";
import type CompileError from "../types/CompileError.ts";
import type Token from "../types/Token.ts";

export default interface ParseStatus {
  /**
   * Tokens extracted from source code
   */
  tokens: Token[];
  /**
   * The current token index
   */
  i: number;
  /**
   * The current node
   */
  stack: BaseNode[];
  /**
   * The current namespace
   */
  namespace: string;
  /**
   * Errors that have been encountered
   */
  errors: CompileError[];
}
