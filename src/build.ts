import type BuildStatus from "./build/BuildStatus";
import build_c_node from "./build/build_node";
import build_aarch64_node from "./build_aarch64/build_node";
import { reset_label_counter as reset_for_label_counter } from "./build_aarch64/build_for_loop_node";
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
    reset_access_temp_counter();
    reset_func_call_temp_counter();
    build_aarch64_node(root, status);
    if (status.strings && status.strings.size > 0) {
      status.code += "\n";
      for (const [label, value] of status.strings) {
        status.code += `${label}: .asciz ${value}\n`;
      }
    }
  } else {
    build_c_node(root, status);
  }

  return {
    headers: status.headers,
    code: status.code,
  };
}
