import DeclarationNode from "../nodes/DeclarationNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import check_type_exists from "./utils/check_type_exists.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_declaration_node(decl: DeclarationNode, status: CheckStatus) {
	if (decl.func_params) {
		if (decl.func_return_type) {
			check_type_exists(decl.func_return_type, status, -1);
		}
		for (const param of decl.func_params) {
			if (param.type.name) {
				check_type_exists(param.type, status, param.type_start!);
			}
		}

		if (decl.value && decl.value.node_type === "func") {
			for (const param of decl.func_params) {
				status.values.push({
					declaration: param.declaration,
					name: param.name,
					type: param.type,
					is_set: true,
				});
			}
			status.stack.push(decl);
			check_node(decl.value, status);
			status.stack.pop();
			return;
		} else if (decl.value) {
			status.stack.push(decl);

			const old_expected_type = status.expected_type;
			status.expected_type = decl.type;
			const result = check_node(decl.value, status);
			status.expected_type = old_expected_type;

			if (result) {
				check_type_and_value_match(
					decl.type,
					type_from_value_node(decl.value, status),
					value_from_value_node(decl.value),
					status,
					decl.value.start,
					"declaration",
				);
			}

			if (!decl.type.name) {
				decl.type = type_from_value_node(decl.value, status);
			} else if (decl.value.node_type === "array" && !decl.type.is_array) {
				const value_type = type_from_value_node(decl.value, status);
				if (value_type.is_array && value_type.name === decl.type.name) {
					decl.type.is_array = true;
					decl.type.length = value_type.length;
				}
			}

			status.stack.pop();
		}

		status.values.push({
			declaration: decl.declaration,
			name: decl.name,
			type: decl.func_return_type || decl.type,
			is_set: !!decl.value,
			start: decl.start,
		});
	} else {
		if (decl.type.name) {
			check_type_exists(decl.type, status, decl.type_start!);
		}

		if (decl.value) {
			status.stack.push(decl);

			const old_expected_type = status.expected_type;
			status.expected_type = decl.type;
			const result = check_node(decl.value, status);
			status.expected_type = old_expected_type;

			if (result) {
				check_type_and_value_match(
					decl.type,
					type_from_value_node(decl.value, status),
					value_from_value_node(decl.value),
					status,
					decl.value.start,
					"declaration",
				);
			}

			if (!decl.type.name) {
				decl.type = type_from_value_node(decl.value, status);
			} else if (decl.value.node_type === "array" && !decl.type.is_array) {
				const value_type = type_from_value_node(decl.value, status);
				if (value_type.is_array && value_type.name === decl.type.name) {
					decl.type.is_array = true;
					decl.type.length = value_type.length;
				}
			}

			status.stack.pop();
		}

		status.values.push({
			declaration: decl.declaration,
			name: decl.name,
			type: decl.type,
			is_set: !!decl.value,
			start: decl.start,
		});
	}
}
