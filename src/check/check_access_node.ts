import AccessFieldNode from "../nodes/AccessFieldNode";
import AccessInvocationNode from "../nodes/AccessInvocationNode";
import AccessNode from "../nodes/AccessNode";
import Type from "../nodes/Type";
import type CheckStatus from "./CheckStatus";
import check_invocation_function from "./check_invocation_function";
import check_node from "./check_node";
import type_from_value_node from "./utils/type_from_value_node";
import value_from_value_node from "./utils/value_from_value_node";

export default function check_access_node(node: AccessNode, status: CheckStatus) {
  check_node(node.source, status);

  const source_type = type_from_value_node(node.source, status);
  if (!source_type.name) {
    console.log("WHAT IS THIS", node);
    status.errors.push({
      message: `Unknown target: ${value_from_value_node(node.source)}`,
      start: node.source.start,
    });
    return;
  }

  switch (node.access.node_type) {
    case "ac_field": {
      check_access_field_node(source_type, node.access as AccessFieldNode, status);
      break;
    }
    case "ac_invoke": {
      check_access_invocation_node(source_type, node.access as AccessInvocationNode, status);
      break;
    }
  }
}

function check_access_field_node(source_type: Type, node: AccessFieldNode, status: CheckStatus) {
  const struct = status.structs.find((s) => s.name === source_type.name);
  let field = struct?.fields.find((f) => f.name === node.name);
  if (!field) {
    // Are we accessing a field in a trait?
    const trait = status.traits.find((s) => s.name === source_type.name);
    if (trait) {
      field = trait?.fields.find((f) => f.name === node.name);
    }
  }
  if (!field) {
    // Are we accessing a field in a struct with a trait and a default value?
    const struct = status.structs.find((s) => s.name === source_type.name);
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
    if (field.visibility === "private") {
      // TODO: You CAN do this from within the correct scope
      status.errors.push({
        message: `Can't access secret field: ${node.name}`,
        start: node.start,
      });
    } else {
      node.type = field.type;
    }
  } else {
    status.errors.push({
      message: `Field not found: ${node.name}`,
      start: node.start,
    });
  }
}

function check_access_invocation_node(
  source_type: Type,
  node: AccessInvocationNode,
  status: CheckStatus,
) {
  const struct = status.structs.find((s) => s.name === source_type.name);
  let func = struct?.functions.find((f) => f.name === node.name);
  if (!func) {
    // Are we accessing a func in a trait?
    const trait = status.traits.find((s) => s.name === source_type.name);
    if (trait) {
      func = trait.functions.find((f) => f.name === node.name);
    }
  }
  if (!func) {
    // TODO:
    // Are we accessing a func in a struct with a trait and a default value?
  }
  check_invocation_function(node, status, func);
}
