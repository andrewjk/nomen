import ValueNode from "../nodes/ValueNode";
import type CheckStatus from "./CheckStatus";
import type_from_value from "./utils/type_from_value";

export default function check_value_node(value: ValueNode, status: CheckStatus) {
  value.type = type_from_value(value.value, status);
}
