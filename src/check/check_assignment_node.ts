import add_error from "../add_error";
import AssignmentNode from "../nodes/AssignmentNode";
import type CheckStatus from "./CheckStatus";
import check_node from "./check_node";
import check_type_and_value_match from "./utils/check_type_and_value_match";
import type_from_value_node from "./utils/type_from_value_node";
import value_from_value_node from "./utils/value_from_value_node";

export default function check_assignment_node(
  assign: AssignmentNode,
  status: CheckStatus,
): boolean {
  if (!check_node(assign.left_value, status)) {
    return false;
  }

  const old_expected_type = status.expected_type;
  status.expected_type = type_from_value_node(assign.left_value, status);
  const result = check_node(assign.right_value, status);
  status.expected_type = old_expected_type;
  if (!result) {
    return false;
  }

  // Make sure the left value exists and can be assigned to
  // * If this is a variable, it's the variable itself e.g. for `x = 5` we would
  //   check that `x` exists and can be assigned to
  // * If this is an access, it's the root target e.g. for `person.address.zip =
  //   1234` we would check that `person` exists and can be assigned to
  const left_value_name = value_from_value_node(assign.left_value);
  const left_value = status.values.find((v) => v.name === left_value_name);
  if (!left_value) {
    add_error(status, `Unknown variable: ${left_value_name}`, assign.left_value!.start);
    return false;
  } else if (left_value.declaration !== "var") {
    if (left_value.is_set) {
      add_error(status, `Assignment to const: ${left_value_name}`, assign.left_value!.start);
      return false;
    } else {
      left_value.is_set = true;
    }
  }

  // Make sure that the types match
  // * If this is a variable, it's the variable itself e.g. for `x = 5` we would
  //   check that the types of `x` and `5` match
  // * If this is an access, it's the field target e.g. for `person.address.zip
  //   = 1234` we would check that the types of `zip` and `1234` match
  //if (left_value)
  check_type_and_value_match(
    type_from_value_node(assign.left_value, status),
    type_from_value_node(assign.right_value, status),
    value_from_value_node(assign.right_value),
    status,
    assign.right_value.start,
    "assignment",
  );

  return true;
}
