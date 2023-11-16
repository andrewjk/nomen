import type ParseError from "./ParseError";
import type ParseNode from "./ParseNode";

export default interface ParseResult {
  ok: boolean;
  root: ParseNode;
  errors: ParseError[];
}
