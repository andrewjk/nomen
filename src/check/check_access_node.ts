import add_error from "../add_error";
import AccessFieldNode from "../nodes/AccessFieldNode";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode";
import AccessNode from "../nodes/AccessNode";
import Type from "../nodes/Type";
import type CheckStatus from "./CheckStatus";
import check_function_call from "./check_function_call";
import check_node from "./check_node";
import type_from_value_node from "./utils/type_from_value_node";
import value_from_value_node from "./utils/value_from_value_node";

export default function check_access_node(node: AccessNode, status: CheckStatus) {
  check_node(node.target, status);

  const target_type = type_from_value_node(node.target, status);
  if (!target_type.name) {
    add_error(status, `Unknown target: ${value_from_value_node(node.target)}`, node.target.start);
    return;
  }

  switch (node.access.node_type) {
    case "access_field": {
      check_access_field_node(target_type, node.access as AccessFieldNode, status);
      break;
    }
    case "access_func": {
      check_access_function_node(target_type, node.access as AccessFunctionCallNode, status);
      break;
    }
  }
}

function check_access_field_node(target_type: Type, node: AccessFieldNode, status: CheckStatus) {
  const struct = status.structs.find((s) => s.name === target_type.name);
  let field = struct?.fields.find((f) => f.name === node.name);
  if (!field) {
    // Are we accessing a field in a trait?
    const trait = status.traits.find((s) => s.name === target_type.name);
    if (trait) {
      field = trait?.fields.find((f) => f.name === node.name);
    }
  }
  if (!field) {
    // Are we accessing a field in a struct with a trait and a default value?
    const struct = status.structs.find((s) => s.name === target_type.name);
    if (struct) {
      for (let trait_name of struct.traits) {
        const trait = status.traits.find((s) => s.name === trait_name);
        if (trait) {
          field = trait.fields.find((f) => f.name === node.name && f.value);
          break;
        }
      }
    }
  }
  if (field) {
    if (
      field.visibility === "private" &&
      !status.structs.find((s) => s.name === target_type.name)?.privates_visible
    ) {
      add_error(status, `Can't access private field: ${node.name}`, node.start);
    } else {
      node.type = field.type;
    }
  } else {
    add_error(status, `Field not found: ${node.name}`, node.start);
  }
}

function check_access_function_node(
  target_type: Type,
  node: AccessFunctionCallNode,
  status: CheckStatus,
) {
  const struct = status.structs.find((s) => s.name === target_type.name);

  let func = struct?.functions.find((f) => f.name === node.name);

  if (!func) {
    // Are we accessing a func in a trait?
    const trait = status.traits.find((s) => s.name === target_type.name);
    if (trait) {
      func = trait.functions.find((f) => f.name === node.name);
    }
  }

  if (!func) {
    // Are we accessing a func in a struct with a trait and a default value?
    const struct = status.structs.find((s) => s.name === target_type.name);
    if (struct) {
      for (let trait_name of struct.traits) {
        const trait = status.traits.find((s) => s.name === trait_name);
        if (trait) {
          func = trait.functions.find((f) => f.name === node.name && f.has_body);
          break;
        }
      }
    }
  }

  // Make sure the function exists
  if (!func) {
    add_error(status, `Function not found: ${target_type.name}.${node.name}`, node.start);
    return;
  }

  check_function_call(node, status, func, target_type);
}
