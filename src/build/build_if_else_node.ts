import IfElseNode from "../nodes/IfElseNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";

export default function build_if_else_node(node: IfElseNode, status: BuildStatus) {
  status.code += `if (`;
  build_node(node.condition, status);
  status.code += `) {\n`;
  for (let child of node.if_branch.statements) {
    build_node(child, status);
  }
  if (node.else_branch) {
    status.code += `} else {\n`;
    for (let child of node.else_branch.statements) {
      build_node(child, status);
    }
  }
  status.code += `}\n`;
}
