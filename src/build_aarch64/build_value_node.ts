import ValueNode from "../nodes/ValueNode";
import type BuildStatus from "../build/BuildStatus";

function is_literal(value: string): boolean {
  return (
    /^(\+|-)*\d+$/.test(value) ||
    /^(\+|-)*\d+.\d+$/.test(value) ||
    value === "true" ||
    value === "false"
  );
}

export default function build_value_node(node: ValueNode, status: BuildStatus) {
  let value = node.value.replace("self", "_self");

  if (value === "true") {
    value = "1";
  } else if (value === "false") {
    value = "0";
  }

  if (is_literal(value)) {
    status.code += `ldr x0, =${value}`;
  } else {
    status.code += `adr x0, ${value}\nldr x0, [x0]`;
  }
}
