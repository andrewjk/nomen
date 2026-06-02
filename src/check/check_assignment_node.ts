import add_error from "../add_error.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import { is_class_type } from "./utils/ownership.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

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
	} else if (
		left_value.declaration !== "var" &&
		!left_value.type.is_ref &&
		left_value_name !== "self"
	) {
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

	const rhs_type = type_from_value_node(assign.right_value, status);
	if (
		!assign.swap &&
		assign.right_value.node_type === "access" &&
		rhs_type.name &&
		is_class_type(rhs_type.name, status)
	) {
		add_error(
			status,
			`cannot assign class field '${rhs_type.name}' from another owner, use mov with swap`,
			assign.right_value.start,
		);
	}

	if (assign.swap) {
		check_node(assign.swap, status);
		const left_type = type_from_value_node(assign.left_value, status);
		const swap_type = type_from_value_node(assign.swap, status);
		check_type_and_value_match(left_type, swap_type, undefined, status, assign.swap.start, "swap");
	}

	return true;
}
