import RangeNode from "../nodes/RangeNode";
import type CheckStatus from "./CheckStatus";
import check_node from "./check_node";
import check_type_and_value_match from "./utils/check_type_and_value_match";
import type_from_value_node from "./utils/type_from_value_node";
import value_from_value_node from "./utils/value_from_value_node";

export default function check_range_node(range: RangeNode, status: CheckStatus): boolean {
  let result = check_node(range.left_value, status) && check_node(range.right_value, status);
  if (!result) {
    return false;
  }

  check_type_and_value_match(
    type_from_value_node(range.left_value, status),
    type_from_value_node(range.right_value, status),
    value_from_value_node(range.right_value),
    status,
    range.right_value.start,
    "range",
  );

  return true;
}
