import IfElseNode from "../nodes/IfElseNode";
import type BuildStatus from "./BuildStatus";
import build_auto_free from "./build_auto_free";
import build_block_node from "./build_block_node";
import build_node from "./build_node";

export default function build_if_else_node(node: IfElseNode, status: BuildStatus) {
  const old_scoped_declarations = status.scoped_declarations;
  status.scoped_declarations = [];

  status.code += `if (`;
  build_node(node.condition, status);
  status.code += `) {\n`;
  if (node.if_branch) {
    build_block_node(node.if_branch, status);
    build_auto_free(status);
  }
  if (node.else_branch) {
    status.code += `} else {\n`;
    build_block_node(node.else_branch, status);
    build_auto_free(status);
  }
  status.code += `}\n`;

  status.scoped_declarations = old_scoped_declarations;
}
