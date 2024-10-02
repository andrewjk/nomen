import IfElseNode from "../nodes/IfElseNode";
import type BuildStatus from "./BuildStatus";
import build_block_node from "./build_block_node";
import build_node from "./build_node";

export default function build_if_else_node(node: IfElseNode, status: BuildStatus) {
  status.code += `if (`;
  build_node(node.condition, status);
  status.code += `) {\n`;
  if (node.if_branch) {
    build_block_node(node.if_branch, status);
  }
  if (node.else_branch) {
    status.code += `} else {\n`;
    build_block_node(node.else_branch, status);
  }
  status.code += `}\n`;
}
