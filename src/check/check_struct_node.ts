import StructNode from "../nodes/StructNode";
import Type from "../nodes/Type";
import type CheckStatus from "./CheckStatus";
import check_declaration_node from "./check_declaration_node";
import check_function_node from "./check_function_node";

export default function check_struct_node(struct: StructNode, status: CheckStatus) {
  for (let trait of struct.traits) {
    if (!status.traits.find((t) => t.name === trait)) {
      status.errors.push({
        message: `Unknown trait: ${trait}`,
        start: struct.start,
      });
    }
  }

  // Add the `self` value that refers to the struct
  status.values.push({
    declaration: "const",
    name: "self",
    type: new Type(struct.name),
  });

  for (let decl of struct.fields) {
    check_declaration_node(decl, status);
  }

  for (let func of struct.functions) {
    check_function_node(func, status);
  }

  // TODO: Remove the `self` value
  status.types.push(struct.name);
  status.structs.push(struct);

  // Add a new value to the stack
  status.values.push({
    declaration: "struct",
    name: struct.name,
    type: new Type(struct.name),
  });
}
