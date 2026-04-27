import ArrayValuesNode from "../nodes/ArrayValuesNode";
import DeclarationNode from "../nodes/DeclarationNode";
import ValueNode from "../nodes/ValueNode";
import type BuildStatus from "../build/BuildStatus";
import build_array_values_node from "./build_array_values_node";
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
    status.code += `${node.name}: ${directive} `;
    if (node.value.node_type === "value") {
      status.code += get_raw_value(node.value as ValueNode);
    } else if (node.value.node_type === "array") {
      build_array_values_node(node.value as ArrayValuesNode, status);
    } else {
      status.code += "// complex init";
    }
  } else {
    status.code += `${node.name}: .space ${size}`;
  }
}
