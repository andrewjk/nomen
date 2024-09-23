import ValueNode from "../nodes/ValueNode";
import type CheckStatus from "./CheckStatus";
import type_from_value from "./utils/type_from_value";

export default function check_value_node(value: ValueNode, status: CheckStatus) {
  // TODO: If there's already a type, check that the value matches
  value.type = type_from_value(value.value, status);
}
