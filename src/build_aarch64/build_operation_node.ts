import OperationNode from "../nodes/OperationNode";
import type BuildStatus from "../build/BuildStatus";
import build_node from "./build_node";

function map_op(op: string): string {
  switch (op) {
    case "+":
      return "add";
    case "-":
      return "sub";
    case "*":
      return "mul";
    case "/":
      return "sdiv";
    default:
      return "add";
  }
}

export default function build_operation_node(
  node: OperationNode,
  status: BuildStatus,
) {
  build_node(node.left_value, status);
  status.code += `\nmov x1, x0\n`;
  build_node(node.right_value, status);
  const op = map_op(node.op);
  status.code += `\n${op} x0, x1, x0\n`;
}
