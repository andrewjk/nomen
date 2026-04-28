import DeclarationNode from "../nodes/DeclarationNode.ts";
import Type from "../nodes/Type.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import check_type_exists from "./utils/check_type_exists.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_declaration_node(decl: DeclarationNode, status: CheckStatus) {
  // Handle function type declarations
  if (decl.func_params) {
    if (decl.func_return_type) {
      check_type_exists(decl.func_return_type, status, -1);
    }
    for (const param of decl.func_params) {
      if (param.type.name) {
        check_type_exists(param.type, status, param.type_start!);
      }
    }

    if (decl.value) {
      status.stack.push(decl);
      check_node(decl.value, status);
      status.stack.pop();
    }

    // Add a new value to the stack
    status.values.push({
      declaration: decl.declaration,
      name: decl.name,
      type: decl.func_return_type || new Type(""),
      is_set: !!decl.value,
    });
    return;
  }

  // NOTE: At this point we must have either type or value
  if (decl.type.name) {
    check_type_exists(decl.type, status, decl.type_start!);
  }

  if (decl.value) {
    status.stack.push(decl);

    //const error_count = status.errors.length;
    const old_expected_type = status.expected_type;
    status.expected_type = decl.type;
    const result = check_node(decl.value, status);
    status.expected_type = old_expected_type;

    if (result) {
      check_type_and_value_match(
        decl.type,
        type_from_value_node(decl.value, status),
        value_from_value_node(decl.value),
        status,
        decl.value.start,
        "declaration",
      );
    }

    if (!decl.type.name) {
      decl.type = type_from_value_node(decl.value, status);
    }

    status.stack.pop();
  }

  // Add a new value to the stack
  status.values.push({
    declaration: decl.declaration,
    name: decl.name,
    type: decl.type,
    is_set: !!decl.value,
  });
}
