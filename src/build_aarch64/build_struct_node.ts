import FunctionNode from "../nodes/FunctionNode";
import StructNode from "../nodes/StructNode";
import type BuildStatus from "../build/BuildStatus";
import build_block_node from "./build_block_node";
import build_function_node from "./build_function_node";
import { get_field_offset, get_struct_size } from "./utils/struct_layout";

export default function build_struct_node(node: StructNode, status: BuildStatus) {
  if (node.is_simple_type) {
    build_struct_functions(node, status);
    return;
  }

  // Build init function
  build_init_function(node, status);

  // Build struct functions
  build_struct_functions(node, status);
}

function build_init_function(node: StructNode, status: BuildStatus) {
  const func_name = `${node.name}_init`;
  const object_name = node.name.substring(0, 1).toLocaleLowerCase();

  // x0 = destination address
  // x1-x7 = field params (fields without default values)
  const required_fields = node.fields.filter((f) => f.value == null);

  status.stack_size = 0;
  status.stack_offsets = new Map();

  status.code += `.p2align 2\n`;
  status.code += `${func_name}:\n`;
  status.code += `stp x29, x30, [sp, #-16]!\n`;
  status.code += `mov x29, sp\n`;

  // Store _vt pointer (null for now)
  status.code += `str xzr, [x0]\n`;

  // Store field params
  const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
  for (let i = 0; i < required_fields.length; i++) {
    const field = required_fields[i];
    const offset = get_field_offset(node.name, field.name, status);
    status.code += `str ${param_regs[i]}, [x0, #${offset}]\n`;
  }

  // Store default fields
  for (const field of node.fields) {
    if (field.value) {
      const offset = get_field_offset(node.name, field.name, status);
      if (field.value.node_type === "value") {
        const val = (field.value as any).value;
        if (val === "true") {
          status.code += `mov x1, #1\n`;
        } else if (val === "false") {
          status.code += `mov x1, #0\n`;
        } else if (/^(\+|-)*\d+$/.test(val)) {
          status.code += `ldr x1, =${val}\n`;
        } else if (val.startsWith('"')) {
          const label = `_str_${func_name}_${field.name}`;
          status.strings!.set(label, val);
          status.code += `adr x1, ${label}\n`;
        } else {
          status.code += `ldr x1, =${val}\n`;
        }
        status.code += `str x1, [x0, #${offset}]\n`;
      }
    }
  }

  status.code += `.return_${func_name}:\n`;
  status.code += `ldp x29, x30, [sp], #16\n`;
  status.code += `ret\n`;

  status.stack_size = undefined;
  status.stack_offsets = undefined;
}

function build_struct_functions(node: StructNode, status: BuildStatus) {
  for (const func of node.functions) {
    if (func.name === "init") continue;

    const old_scoped_declarations = status.scoped_declarations;
    status.scoped_declarations = [];

    status.stack_size = 0;
    status.stack_offsets = new Map();

    const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];
    status.function_param_regs = new Map();
    status.function_param_vars = new Set();

    // For methods, x0 is self
    if (func.params[0]?.is_self_param) {
      status.function_param_regs.set("self", "x0");
      if (func.params[0].declaration === "var") {
        status.function_param_vars.add("self");
      }
      // Field accesses on self will use the base address from x19/x0 with offset
    }

    for (let i = 0; i < func.params.length; i++) {
      if (!func.params[i].is_self_param) {
        status.function_param_regs.set(func.params[i].name, param_regs[i]);
      }
      if (func.params[i].declaration === "var") {
        status.function_param_vars.add(func.params[i].name);
      }
    }

    const return_label = `.return_${node.name}_${func.name}`;
    status.function_return_label = return_label;

    status.code += `.p2align 2\n`;
    status.code += `${node.name}_${func.name}:\n`;
    status.code += `stp x29, x30, [sp, #-16]!\n`;

    // Save x19 if we need it for self
    const needs_x19 = func.params[0]?.is_self_param && func.params[0]?.declaration !== "var";
    if (needs_x19) {
      status.code += `str x19, [sp, #-16]!\n`;
      status.code += `mov x19, x0\n`;
      status.function_param_regs.set("self", "x19");
    }

    status.code += `mov x29, sp\n`;

    // For non-var self, load fields into "virtual" registers
    // We'll emit load instructions when fields are accessed

    build_block_node(func, status);

    status.code += `${return_label}:\n`;
    if (needs_x19) {
      status.code += `ldr x19, [sp], #16\n`;
    }
    status.code += `ldp x29, x30, [sp], #16\n`;
    status.code += `ret\n`;

    status.scoped_declarations = old_scoped_declarations;
    status.function_param_regs = undefined;
    status.function_param_vars = undefined;
    status.function_return_label = undefined;
    status.stack_size = undefined;
    status.stack_offsets = undefined;
  }
}
