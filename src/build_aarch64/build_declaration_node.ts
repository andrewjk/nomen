import DeclarationNode from "../nodes/DeclarationNode";
import type BuildStatus from "../build/BuildStatus";
import build_node from "../build/build_node";
import aarch64_size from "./utils/aarch64_size";
import aarch64_type from "./utils/aarch64_type";

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
      build_node(node.value, status);
    } else {
      status.code += `${node.name}: .space 0`;
    }
  } else if (node.value) {
    status.code += `${node.name}: ${directive} `;
    build_node(node.value, status);
  } else {
    status.code += `${node.name}: .space ${size}`;
  }
}
