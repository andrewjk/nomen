import AccessFieldNode from "../nodes/AccessFieldNode";
import AccessFunctionNode from "../nodes/AccessFunctionNode";
import Type from "../nodes/Type";
import type ParseStatus from "./ParseStatus";
import parse_function_call_parameter from "./parse_function_call_parameter";
import accept from "./utils/accept";
import consume from "./utils/consume";
import expect from "./utils/expect";
import get_index from "./utils/get_index";
import peek_current from "./utils/peek_current";

export default function parse_access(
  source_name: string,
  status: ParseStatus,
): AccessFieldNode | AccessFunctionNode {
  const start = get_index(status);
  const name = consume(status);

  if (peek_current(status) === "(") {
    accept("(", status);
    const func = new AccessFunctionNode(start, name);
    // HACK:
    if (func.name === "init") {
      func.type = new Type(source_name);
      func.static = true;
    }
    if (peek_current(status) !== ")") {
      parse_function_call_parameter(func, status);
    }
    expect(")", status);
    return func;
  } else {
    return new AccessFieldNode(start, name);
  }
}
