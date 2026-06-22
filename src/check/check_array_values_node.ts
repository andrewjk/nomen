import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_array_values_node(
	array: ArrayValuesNode,
	status: CheckStatus,
): boolean {
	// The type of items in the array, which we will check each value against
	let array_item_type = new Type(array.type.name);

	// If there is an expected type of the array (e.g. for declarations), use it
	if (!array.type.name && status.expected_type) {
		array.type = new Type(
			status.expected_type.name,
			status.expected_type.is_static,
			status.expected_type.is_array,
			status.expected_type.length,
		);
		array.type.is_nullable = status.expected_type.is_nullable;
		array.type.type_args = status.expected_type.type_args;
		array_item_type = new Type(array.type.name);
	}

	let result = true;
	for (let value of array.values) {
		if (!check_node(value, status)) {
			result = false;
			continue;
		}

		const value_type = type_from_value_node(value, status);

		// If the array has no type, use the type from the first value
		// (copy properties — don't alias, since callers may mutate the returned type)
		if (!array.type.name) {
			array.type = new Type(value_type.name);
			array.type.is_array = true;
			array_item_type = new Type(array.type.name);
		}

		check_type_and_value_match(
			array_item_type,
			value_type,
			value_from_value_node(value),
			status,
			value.start,
			"array",
		);
	}

	if (!array.type.length) {
		array.type.length = new ValueNode(-1, array.values.length.toString(), new Type("int"));
	}
	array.type.is_array = true;

	return result;
}
