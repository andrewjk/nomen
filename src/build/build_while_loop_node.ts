import WhileLoopNode from "../nodes/WhileLoopNode";
import type BuildStatus from "./BuildStatus";
import build_auto_free from "./build_auto_free";
import build_block_node from "./build_block_node";
import build_node from "./build_node";

export default function build_while_loop_node(node: WhileLoopNode, status: BuildStatus) {
  const old_scoped_declarations = status.scoped_declarations;
  status.scoped_declarations = [];

  status.code += `while (`;
  build_node(node.condition, status);
  status.code += `) {\n`;

  build_block_node(node, status);

  build_auto_free(status);

  status.code += `}\n`;

  status.scoped_declarations = old_scoped_declarations;
}
