import WhileLoopNode from "../nodes/WhileLoopNode";
import type BuildStatus from "./BuildStatus";
import build_block_node from "./build_block_node";
import build_node from "./build_node";

export default function build_while_loop_node(node: WhileLoopNode, status: BuildStatus) {
  status.code += `while (`;
  build_node(node.condition, status);
  status.code += `) {\n`;
  build_block_node(node, status);
  status.code += `}\n`;
}
