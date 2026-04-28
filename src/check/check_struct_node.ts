import add_error from "../add_error.ts";
import StructNode from "../nodes/StructNode.ts";
import check_declaration_node from "./check_declaration_node.ts";
import check_function_node from "./check_function_node.ts";
import type CheckStatus from "./CheckStatus.ts";

export default function check_struct_node(struct: StructNode, status: CheckStatus) {
  // Check traits
  for (let trait of struct.traits) {
    if (!status.traits.find((t) => t.name === trait)) {
      add_error(status, `Unknown trait: ${trait}`, struct.start);
    }
  }

  // Check declarations
  for (let decl of struct.fields) {
    check_declaration_node(decl, status);
  }

  // Anything within the struct's functions can access priv fields
  // That includes nested struct functions
  struct.privates_visible = true;

  // Struct functions may need to access the struct itself
  status.types.push(struct.name);
  status.structs.push(struct);

  // Check functions
  for (let func of struct.functions) {
    check_function_node(func, status);
  }

  // Don't allow anything from outside to access priv fields
  struct.privates_visible = false;
}
