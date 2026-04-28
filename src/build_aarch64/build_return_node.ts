import ReturnNode from "../nodes/ReturnNode";
import type BuildStatus from "../build/BuildStatus";
import build_node from "./build_node";
import { emit_var_store } from "./utils/stack_var";

export default function build_return_node(
  node: ReturnNode,
  status: BuildStatus,
) {
  if (node.from_c) {
    return;
  }
  build_node(node.value, status);
  if (status.return_assign) {
    if (!status.code.endsWith("\n")) {
      status.code += "\n";
    }
    emit_var_store(status, "x0", status.return_assign, 8);
  } else if (status.function_return_label) {
    if (!status.code.endsWith("\n")) {
      status.code += "\n";
    }
    status.code += `b ${status.function_return_label}\n`;
  }
}
