import FunctionCallNode from "../nodes/FunctionCallNode";
import type BuildStatus from "../build/BuildStatus";
import build_node from "./build_node";

let temp_counter = 0;

export function reset_temp_counter() {
  temp_counter = 0;
}

export default function build_function_call_node(
  node: FunctionCallNode,
  status: BuildStatus,
) {
  const is_struct = status.structs.find(
    (s) => s.name === node.name && !s.is_simple_type,
  );
  const func_name = is_struct ? `${node.name}_init` : node.name;
  const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];

  let start_reg = 0;

  if (is_struct) {
    // Struct constructor
    if (status.struct_return_buffer) {
      // Use the provided return buffer address
      status.code += `mov x0, ${status.struct_return_buffer}\n`;
    } else {
      // Create a temp
      const dest_addr = `_temp_${temp_counter++}`;
      status.code += `${dest_addr}: .space 16\n`;
      status.code += `adr x0, ${dest_addr}\n`;
    }
    start_reg = 1;
  }

  // Evaluate params right-to-left to avoid clobbering
  for (let i = node.params.length - 1; i >= 0; i--) {
    build_node(node.params[i], status);
    const reg = param_regs[start_reg + i];
    if (reg !== "x0") {
      status.code += `\nmov ${reg}, x0\n`;
    } else {
      status.code += `\n`;
    }
  }

  status.code += `bl ${func_name}\n`;

  // For struct constructors with a temp, load temp address into x0
  if (is_struct && !status.struct_return_buffer) {
    // Find the last temp created
    const temp_addr = `_temp_${temp_counter - 1}`;
    status.code += `adr x0, ${temp_addr}\n`;
  }

  if (node.name.startsWith("_string_interpolate_")) {
    status.interpolate_string_counts.add(node.params.length - 1);
  }
}
