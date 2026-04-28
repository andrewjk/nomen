import type BuildStatus from "./build/BuildStatus";
import build_c_node from "./build/build_node";
import build_aarch64_node from "./build_aarch64/build_node";
import { reset_label_counter as reset_for_label_counter } from "./build_aarch64/build_for_loop_node";
import { reset_label_counter as reset_func_label_counter } from "./build_aarch64/build_function_node";
import { reset_label_counter as reset_if_label_counter } from "./build_aarch64/build_if_else_node";
import { reset_label_counter as reset_while_label_counter } from "./build_aarch64/build_while_loop_node";
import { reset_access_temp_counter } from "./build_aarch64/build_access_node";
import { reset_temp_counter as reset_func_call_temp_counter } from "./build_aarch64/build_function_call_node";
import { reset_string_counter as reset_op_string_counter } from "./build_aarch64/build_operation_node";
import { reset_string_counter as reset_value_string_counter } from "./build_aarch64/build_value_node";
import BaseNode from "./nodes/BaseNode";
import type BuildResult from "./types/BuildResult";

export default function build(
  root: BaseNode,
  options: { arch?: "c" | "aarch64" } = {},
): BuildResult {
  let status: BuildStatus = {
    root,
    structs: [],
    traits: [],
    headers: "",
    code: "",
    scoped_declarations: [],
    interpolate_string_counts: new Set(),
    strings: new Map(),
  };

  if (options.arch === "aarch64") {
    reset_value_string_counter();
    reset_op_string_counter();
    reset_if_label_counter();
    reset_for_label_counter();
    reset_while_label_counter();
    reset_func_label_counter();
    reset_access_temp_counter();
    reset_func_call_temp_counter();
    build_aarch64_node(root, status);
    if (status.strings && status.strings.size > 0) {
      status.code += "\n";
      for (const [label, value] of status.strings) {
        status.code += `${label}: .asciz ${value}\n`;
      }
    }
    // Generate _string_interpolate_N helpers for aarch64
    for (const length of status.interpolate_string_counts) {
      status.code += `\n.p2align 2\n`;
      status.code += `_string_interpolate_${length}:\n`;
      status.code += `stp x29, x30, [sp, #-16]!\n`;
      status.code += `mov x29, sp\n`;
      // Stack layout: args at #0..#48, length at #56, str at #64, pattern at #72
      status.code += `sub sp, sp, #80\n`;
      status.code += `str x0, [sp, #72]\n`;
      const argRegs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
      for (let i = 0; i < length && i < argRegs.length; i++) {
        status.code += `str ${argRegs[i]}, [sp, #${i * 8}]\n`;
      }
      // Call snprintf(NULL, 0, pattern, args...)
      status.code += `mov x0, xzr\n`;
      status.code += `mov x1, xzr\n`;
      status.code += `ldr x2, [sp, #72]\n`;
      const variadicRegs = ["x3", "x4", "x5", "x6", "x7"];
      for (let i = 0; i < length && i < variadicRegs.length; i++) {
        status.code += `ldr ${variadicRegs[i]}, [sp, #${i * 8}]\n`;
      }
      status.code += `bl _snprintf\n`;
      status.code += `add x0, x0, #1\n`;
      status.code += `str x0, [sp, #56]\n`;
      status.code += `bl _malloc\n`;
      status.code += `str x0, [sp, #64]\n`;
      status.code += `ldr x0, [sp, #64]\n`;
      status.code += `ldr x1, [sp, #56]\n`;
      status.code += `ldr x2, [sp, #72]\n`;
      for (let i = 0; i < length && i < variadicRegs.length; i++) {
        status.code += `ldr ${variadicRegs[i]}, [sp, #${i * 8}]\n`;
      }
      status.code += `bl _snprintf\n`;
      status.code += `ldr x0, [sp, #64]\n`;
      status.code += `add sp, sp, #80\n`;
      status.code += `ldp x29, x30, [sp], #16\n`;
      status.code += `ret\n`;
    }
  } else {
    build_c_node(root, status);
  }

  return {
    headers: status.headers,
    code: status.code,
  };
}
