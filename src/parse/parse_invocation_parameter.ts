import AccessInvocationNode from "../nodes/AccessInvocationNode";
import InvocationNode from "../nodes/InvocationNode";
import type ParseStatus from "./ParseStatus";
import parse_expression from "./parse_expression";
import accept from "./utils/accept";

export default function parse_invocation_parameter(
  invoke: InvocationNode | AccessInvocationNode,
  status: ParseStatus,
) {
  const param = parse_expression(status);
  invoke.params.push(param);

  // Next parameter
  if (accept(",", status)) {
    parse_invocation_parameter(invoke, status);
  }
}
