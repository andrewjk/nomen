import ArrayValuesNode from "../nodes/ArrayValuesNode";
import DeclarationNode from "../nodes/DeclarationNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";
import c_type from "./utils/c_type";
import type_from_value_node from "./utils/type_from_value_node";

export default function build_declaration_node(node: DeclarationNode, status: BuildStatus) {
  // TODO: malloc() if it's on the heap

  // HACK: Move the array part of a declaration after the variable name if applicable
  // If it's an array of traits, make it contain pointers
  if (
    node.type.is_array &&
    status.traits.find((t) => t.name === node.type.name) &&
    node.value &&
    node.value.node_type === "array"
  ) {
    const array_values = node.value as ArrayValuesNode;
    // Support GCC by defining vars first
    const variables: string[] = [];
    let i = 1;
    for (let value of array_values.values) {
      const var_type = type_from_value_node(value);
      const var_name = `_${node.name}_${i}`;
      status.scoped_declarations.push(
        new DeclarationNode(node.start, node.visibility, node.declaration, var_name, var_type),
      );
      // HACK:
      status.code += `${c_type(var_type.name)} ${var_name} = `;
      build_node(value, status);
      status.code += ";\n";
      i += 1;
      variables.push(var_name);
    }

    // Then build the array
    status.code += `void *${node.name}[`;
    if (node.type.length) {
      build_node(node.type.length, status);
    }
    status.code += `] = {${variables.map((v) => `&${v}`).join(", ")}};\n`;
  } else {
    status.scoped_declarations.push(node);

    status.code += `${c_type(node.type.name)} ${node.name}`;
    if (node.type.is_array) {
      status.code += `[`;
      if (node.type.length) {
        build_node(node.type.length, status);
      }
      status.code += `]`;
    }
    if (node.value) {
      // TODO: This should be in more places?? Or apply to more nodes?? Probably
      // in build_node -- if it's a returning node??
      if (node.value.node_type === "if") {
        status.code += ";\n";
        const old_return_assign = status.return_assign;
        status.return_assign = node.name;
        build_node(node.value, status);
        status.return_assign = old_return_assign;
        // HACK:
        status.code += "\n";
        return;
      } else {
        status.code += " = ";
        build_node(node.value, status);
      }
    }
    status.code += ";\n";
  }
}
