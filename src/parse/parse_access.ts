import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import parse_function_call_parameter from "./parse_function_call_parameter.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_access(
  target_name: string,
  status: ParseStatus,
): AccessFieldNode | AccessFunctionCallNode {
  const start = get_index(status);
  const name = consume(status);

  if (peek_current(status) === "(") {
    accept("(", status);
    const func = new AccessFunctionCallNode(start, name);
    if (peek_current(status) !== ")") {
      parse_function_call_parameter(func, status);
    }
    expect(")", status);
    return func;
  } else {
    return new AccessFieldNode(start, name);
  }
}
