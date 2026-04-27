import IfElseNode from "../nodes/IfElseNode";
import type BuildStatus from "../build/BuildStatus";
import build_block_node from "./build_block_node";
import build_node from "./build_node";

let label_counter = 0;

export function reset_label_counter() {
  label_counter = 0;
}

export default function build_if_else_node(
  node: IfElseNode,
  status: BuildStatus,
) {
  const label = label_counter++;
  const old_scoped_declarations = status.scoped_declarations;
  status.scoped_declarations = [];

  build_node(node.condition, status);
  status.code += `\ncmp x0, #0\n`;

  if (node.else_branch) {
    status.code += `beq else_${label}\n`;
    build_block_node(node.if_branch!, status);
    status.code += `b end_${label}\n`;
    status.code += `else_${label}:\n`;
    build_block_node(node.else_branch, status);
  } else {
    status.code += `beq end_${label}\n`;
    if (node.if_branch) {
      build_block_node(node.if_branch, status);
    }
  }

  status.code += `end_${label}:\n`;

  status.scoped_declarations = old_scoped_declarations;
}
