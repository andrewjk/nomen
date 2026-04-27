import ReturnNode from "../nodes/ReturnNode";
import type BuildStatus from "../build/BuildStatus";
import build_node from "./build_node";

export default function build_return_node(
  node: ReturnNode,
  status: BuildStatus,
) {
  build_node(node.value, status);
  if (status.return_assign) {
    if (!status.code.endsWith("\n")) {
      status.code += "\n";
    }
    status.code += `adr x1, ${status.return_assign}\nstr x0, [x1]\n`;
  } else if (status.function_return_label) {
    if (!status.code.endsWith("\n")) {
      status.code += "\n";
    }
    status.code += `b ${status.function_return_label}\n`;
  }
}
