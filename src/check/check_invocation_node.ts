import InvocationNode from "../nodes/InvocationNode";
import type CheckStatus from "./CheckStatus";
import check_invocation_function from "./check_invocation_function";

export default function check_invocation_node(invoke: InvocationNode, status: CheckStatus) {
  const func = status.functions.find((f) => f.name === invoke.name);
  check_invocation_function(invoke, status, func);
}
