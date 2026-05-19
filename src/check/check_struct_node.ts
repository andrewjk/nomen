import add_error from "../add_error.ts";
import StructNode from "../nodes/StructNode.ts";
import check_declaration_node from "./check_declaration_node.ts";
import check_function_node from "./check_function_node.ts";
import type CheckStatus from "./CheckStatus.ts";

export default function check_struct_node(struct: StructNode, status: CheckStatus) {
	for (let trait of struct.traits) {
		if (!status.traits.find((t) => t.name === trait)) {
			add_error(status, `Unknown trait: ${trait}`, struct.start);
		}
	}

	for (let i = 0; i < struct.fields.length; i++) {
		for (let j = i + 1; j < struct.fields.length; j++) {
			if (struct.fields[i].name === struct.fields[j].name) {
				add_error(
					status,
					`Field already declared: ${struct.fields[j].name}`,
					struct.fields[j].start,
				);
			}
		}
	}

	for (let i = 0; i < struct.functions.length; i++) {
		for (let j = i + 1; j < struct.functions.length; j++) {
			if (struct.functions[i].name === struct.functions[j].name) {
				add_error(
					status,
					`Function already declared: ${struct.functions[j].name}`,
					struct.functions[j].start,
				);
			}
		}
	}

	const types_length_before = status.types.length;
	status.types.push(...struct.type_params);

	const type_params_length_before = status.type_params.length;
	status.type_params.push(...struct.type_params);

	const values_length_before_fields = status.values.length;
	for (let decl of struct.fields) {
		check_declaration_node(decl, status);
	}
	status.values.length = values_length_before_fields;

	struct.privates_visible = true;

	status.types.push(struct.name);
	status.structs.push(struct);

	for (let func of struct.functions) {
		check_function_node(func, status);
	}

	struct.privates_visible = false;

	status.type_params.length = type_params_length_before;
	status.types.length = types_length_before;
	status.types.push(struct.name);
}
