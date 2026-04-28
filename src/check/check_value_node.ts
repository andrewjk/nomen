import add_error from "../add_error.ts";
import ValueNode from "../nodes/ValueNode.ts";
import type CheckStatus from "./CheckStatus.ts";
import type_from_value from "./utils/type_from_value.ts";

export default function check_value_node(node: ValueNode, status: CheckStatus): boolean {
  node.type = type_from_value(node.value, status);

  if (!node.type.name) {
    add_error(status, `Unknown value: ${node.value}`, node.start);
    return false;
  }

  return true;
}
