import FunctionCallNode from "../nodes/FunctionCallNode";
import type BuildStatus from "../build/BuildStatus";
import build_node from "./build_node";

export default function build_function_call_node(
  node: FunctionCallNode,
  status: BuildStatus,
) {
  const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];

  // Evaluate params right-to-left to avoid clobbering
  for (let i = node.params.length - 1; i >= 0; i--) {
    build_node(node.params[i], status);
    if (param_regs[i] !== "x0") {
      status.code += `\nmov ${param_regs[i]}, x0\n`;
    } else {
      status.code += `\n`;
    }
  }

  status.code += `bl ${node.name}\n`;

  if (node.name.startsWith("_string_interpolate_")) {
    status.interpolate_string_counts.add(node.params.length - 1);
  }
}
