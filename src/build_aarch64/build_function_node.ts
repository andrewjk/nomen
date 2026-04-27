import FunctionNode from "../nodes/FunctionNode";
import type BuildStatus from "../build/BuildStatus";
import build_block_node from "./build_block_node";

export default function build_function_node(
  node: FunctionNode,
  status: BuildStatus,
) {
  const old_scoped_declarations = status.scoped_declarations;
  status.scoped_declarations = [];

  const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];
  status.function_param_regs = new Map();
  for (let i = 0; i < node.params.length; i++) {
    status.function_param_regs.set(node.params[i].name, param_regs[i]);
  }

  status.code += `${node.name}:\n`;
  status.code += `stp x29, x30, [sp, #-16]!\n`;
  status.code += `mov x29, sp\n`;

  build_block_node(node, status);

  status.code += `ldp x29, x30, [sp], #16\n`;
  status.code += `ret\n`;

  status.scoped_declarations = old_scoped_declarations;
  status.function_param_regs = undefined;
}
