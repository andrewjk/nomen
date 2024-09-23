import ReturnNode from "../nodes/ReturnNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";

export default function build_return_node(node: ReturnNode, status: BuildStatus) {
  if (status.return_assign) {
    status.code += `${status.return_assign} = `;
  } else {
    status.code += `return `;
  }
  build_node(node.value, status);
  status.code += `;\n`;
}
