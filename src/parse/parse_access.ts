import AccessFieldNode from "../nodes/AccessFieldNode";
import AccessInvocationNode from "../nodes/AccessInvocationNode";
import Type from "../nodes/Type";
import type ParseStatus from "./ParseStatus";
import parse_invocation_parameter from "./parse_invocation_parameter";
import accept from "./utils/accept";
import consume from "./utils/consume";
import expect from "./utils/expect";
import get_index from "./utils/get_index";
import peek_current from "./utils/peek_current";

export default function parse_access(
  source_name: string,
  status: ParseStatus,
): AccessFieldNode | AccessInvocationNode {
  const start = get_index(status);
  const name = consume(status);

  if (peek_current(status) === "(") {
    accept("(", status);
    const invoke = new AccessInvocationNode(start, name);
    // HACK:
    if (invoke.name === "init") {
      invoke.type = new Type(source_name);
      invoke.static = true;
    }
    if (peek_current(status) !== ")") {
      parse_invocation_parameter(invoke, status);
    }
    expect(")", status);
    return invoke;
  } else {
    return new AccessFieldNode(start, name);
  }
}
