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

function check_access_field_node(source_type: Type, field: AccessFieldNode, status: CheckStatus) {
  const struct = status.structs.find((s) => s.name === source_type.name);
  let prop = struct?.fields.find((f) => f.name === field.name);
  if (!prop) {
    const trait = status.traits.find((s) => s.name === source_type.name);
    prop = trait?.fields.find((f) => f.name === field.name);
  }
  if (prop) {
    if (prop.visibility === "sec") {
      // TODO: You CAN do this from within the correct scope
      status.errors.push({
        message: `Can't access secret field: ${field.name}`,
        start: field.start,
      });
    } else {
      field.type = prop.type;
    }
  } else {
    status.errors.push({
      message: `Field not found: ${field.name}`,
      start: field.start,
    });
  }
}

function check_access_invocation_node(
  source_type: Type,
  invoke: AccessInvocationNode,
  status: CheckStatus,
) {
  const struct = status.structs.find((s) => s.name === source_type.name);
  let func = struct?.functions.find((f) => f.name === invoke.name);
  if (!func) {
    const trait = status.traits.find((s) => s.name === source_type.name);
    func = trait?.functions.find((f) => f.name === invoke.name);
  }
  check_invocation_function(invoke, status, func);
}
