import ArrayValuesNode from "../nodes/ArrayValuesNode";
import DeclarationNode from "../nodes/DeclarationNode";
import FunctionNode from "../nodes/FunctionNode";
import ValueNode from "../nodes/ValueNode";
import type BuildStatus from "../build/BuildStatus";
import build_array_values_node from "./build_array_values_node";
import build_node from "./build_node";
import aarch64_size from "./utils/aarch64_size";
import aarch64_type from "./utils/aarch64_type";

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

  if (node.type.is_array) {
    if (node.value && node.value.node_type === "array") {
      status.code += `${node.name}: ${directive} `;
      build_array_values_node(node.value as ArrayValuesNode, status);
    } else {
      status.code += `${node.name}: .space 0`;
    }
  } else if (node.value) {
    if (node.value.node_type === "value") {
      status.code += `${node.name}: ${directive} ${get_raw_value(node.value as ValueNode)}`;
    } else if (node.value.node_type === "array") {
      status.code += `${node.name}: ${directive} `;
      build_array_values_node(node.value as ArrayValuesNode, status);
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
