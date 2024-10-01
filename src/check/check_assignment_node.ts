import AssignmentNode from "../nodes/AssignmentNode";
import type CheckStatus from "./CheckStatus";
import check_node from "./check_node";
import check_type_and_value_match from "./utils/check_type_and_value_match";
import type_from_value_node from "./utils/type_from_value_node";
import value_from_value_node from "./utils/value_from_value_node";

export default function check_assignment_node(assign: AssignmentNode, status: CheckStatus) {
  check_node(assign.left_value, status);

  const old_expected_type = status.expected_type;
  status.expected_type = type_from_value_node(assign.left_value, status);
  check_node(assign.right_value, status);
  status.expected_type = old_expected_type;

  // Make sure the left value exists and can be assigned to
  const left_value_name = value_from_value_node(assign.left_value);
  const left_value = status.values.find((v) => v.name === left_value_name);
  if (!left_value) {
    status.errors.push({
      message: `Unknown variable: ${left_value_name}`,
      start: assign.left_value!.start,
    });
  } else if (left_value.declaration !== "var") {
    if (left_value.is_set) {
      status.errors.push({
        message: `Assignment to const: ${left_value_name}`,
        start: assign.left_value!.start,
      });
    } else {
      left_value.is_set = true;
    }
  }

  if (left_value)
    check_type_and_value_match(
      left_value.type,
      type_from_value_node(assign.right_value, status),
      value_from_value_node(assign.right_value),
      status,
      assign.right_value.start,
      "assignment",
    );
}
