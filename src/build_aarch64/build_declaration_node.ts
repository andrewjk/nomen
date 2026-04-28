import ArrayValuesNode from "../nodes/ArrayValuesNode";
import DeclarationNode from "../nodes/DeclarationNode";
import FunctionCallNode from "../nodes/FunctionCallNode";
import RangeNode from "../nodes/RangeNode";
import ValueNode from "../nodes/ValueNode";
import type BuildStatus from "../build/BuildStatus";
import build_array_values_node from "./build_array_values_node";
import build_node from "./build_node";
import build_range_node from "./build_range_node";
import aarch64_size from "./utils/aarch64_size";
import aarch64_type from "./utils/aarch64_type";
import { get_struct_size } from "./utils/struct_layout";

function get_raw_value(node: ValueNode): string {
  let val = node.value;
  if (val === "true") return "1";
  if (val === "false") return "0";
  return val;
}

export default function build_declaration_node(
  node: DeclarationNode,
  status: BuildStatus,
) {
  // Function type declaration
  if (node.func_params) {
    if (node.value && node.value.node_type === "func") {
      build_node(node.value, status);
    } else {
      status.code += `${node.name}: .space 8`;
    }
    return;
  }

  status.scoped_declarations.push(node);

  const directive = aarch64_type(node.type.name);
  const size = aarch64_size(node.type.name);

  // Check if type is a struct
  const struct_type = status.structs.find(
    (s) => s.name === node.type.name && !s.is_simple_type,
  );

  if (node.type.is_array) {
    if (node.value && node.value.node_type === "array") {
      status.code += `${node.name}: ${directive} `;
      build_array_values_node(node.value as ArrayValuesNode, status);
    } else if (node.value && node.value.node_type === "range") {
      status.code += `${node.name}: ${directive} `;
      build_range_node(node.value as RangeNode, status);
    } else {
      status.code += `${node.name}: .space 0`;
    }
  } else if (struct_type) {
    // Struct declaration
    const struct_size = get_struct_size(node.type.name, status);
    if (node.value && node.value.node_type === "func_call") {
      const func_call = node.value as FunctionCallNode;
      const is_constructor = status.structs.find(
        (s) => s.name === func_call.name && !s.is_simple_type,
      );
      if (is_constructor) {
        // Struct constructor: reserve space and call init directly
        status.code += `${node.name}: .space ${struct_size}\n`;
        // Evaluate params into x1-x7 first (before setting x0)
        const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
        for (let i = func_call.params.length - 1; i >= 0; i--) {
          build_node(func_call.params[i], status);
          if (!status.code.endsWith("\n")) {
            status.code += "\n";
          }
          status.code += `mov ${param_regs[i]}, x0\n`;
        }
        // Pass declaration address in x0
        status.code += `adr x0, ${node.name}\n`;
        status.code += `bl ${func_call.name}_init\n`;
      } else {
        status.code += `${node.name}: .space ${struct_size}\n`;
        build_node(node.value, status);
        status.code += `adr x1, ${node.name}\nstr x0, [x1]\n`;
      }
    } else if (node.value) {
      status.code += `${node.name}: .space ${struct_size}\n`;
      build_node(node.value, status);
      if (!status.code.endsWith("\n")) {
        status.code += "\n";
      }
      // Copy struct data from returned address in x0 to declaration
      status.code += `mov x1, x0\n`;
      status.code += `adr x2, ${node.name}\n`;
      const words = Math.ceil(struct_size / 8);
      for (let i = 0; i < words; i++) {
        status.code += `ldr x3, [x1, #${i * 8}]\n`;
        status.code += `str x3, [x2, #${i * 8}]\n`;
      }
    } else {
      status.code += `${node.name}: .space ${struct_size}`;
    }
  } else if (node.value) {
    if (node.value.node_type === "value") {
      status.code += `${node.name}: ${directive} ${get_raw_value(node.value as ValueNode)}`;
    } else if (node.value.node_type === "array") {
      status.code += `${node.name}: ${directive} `;
      build_array_values_node(node.value as ArrayValuesNode, status);
    } else if (node.value.node_type === "range") {
      status.code += `${node.name}: ${directive} `;
      build_range_node(node.value as RangeNode, status);
    } else if (node.value.node_type === "if") {
      status.code += `${node.name}: .space ${size}\n`;
      const old_return_assign = status.return_assign;
      status.return_assign = node.name;
      build_node(node.value, status);
      status.return_assign = old_return_assign;
    } else {
      status.code += `${node.name}: .space ${size}\n`;
      build_node(node.value, status);
      status.code += `adr x1, ${node.name}\nstr x0, [x1]\n`;
    }
  } else {
    status.code += `${node.name}: .space ${size}`;
  }
}
