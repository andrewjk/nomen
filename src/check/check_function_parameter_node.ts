import add_error from "../add_error.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import check_type_exists from "./utils/check_type_exists.ts";
import { is_class_type } from "./utils/ownership.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_function_parameter_node(param: ParameterNode, status: CheckStatus) {
	if (param.is_variadic) {
		if (!param.type.name) {
			add_error(status, `Variadic parameter requires a type`, param.start);
			return;
		}
		check_type_exists(param.type, status, param.type_start!);
		param.type.is_array = true;
	} else if (param.type.name) {
		check_type_exists(param.type, status, param.type_start!);
	}

	// Check for mov on value types (only class types can use mov)
	if (param.is_moved && param.type.name && !is_class_type(param.type.name, status)) {
		add_error(status, `mov is only allowed for class types, not '${param.type.name}'`, param.start);
	}

	if (param.is_variadic && param.default_value) {
		add_error(status, `Variadic parameter cannot have a default value`, param.start);
		return;
	}

	if (param.default_value) {
		if (!check_node(param.default_value, status)) {
			return;
		}

		check_type_and_value_match(
			param.type,
			type_from_value_node(param.default_value, status),
			value_from_value_node(param.default_value),
			status,
			param.default_value_start!,
			"param default",
		);

		if (!param.type.name) {
			param.type = type_from_value_node(param.default_value, status);
		}
	}

	if (status.values.some((v) => v.name === param.name)) {
		add_error(status, `Parameter already declared: ${param.name}`, param.start);
	}

	status.values.push({
		declaration: param.declaration,
		name: param.name,
		type: param.type,
		is_set: true,
		is_null: param.type.is_nullable ? true : undefined,
	});
}
