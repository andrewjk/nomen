import add_error from "../add_error.ts";
import TraitNode from "../nodes/TraitNode.ts";
import check_declaration_node from "./check_declaration_node.ts";
import check_function_node from "./check_function_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { is_class_type } from "./utils/ownership.ts";

export default function check_trait_node(trait: TraitNode, status: CheckStatus) {
	if (!status.types.includes(trait.name)) {
		status.types.push(trait.name);
	}
	if (!status.traits.find((t) => t.name === trait.name)) {
		status.traits.push(trait);
	}

	// Register generic trait type params (e.g. `trait Viewable<T>`) so the
	// trait's own method/field signatures may reference them. Mirrors how
	// check_struct_node scopes a generic struct's type params.
	const types_length_before = status.types.length;
	status.types.push(...trait.type_params);
	const type_params_length_before = status.type_params.length;
	status.type_params.push(...trait.type_params);

	for (let decl of trait.fields) {
		if (decl.declaration === "var" && decl.type.name && is_class_type(decl.type.name, status)) {
			add_error(status, `class-type fields must use 'mov', not 'var'`, decl.start);
		}
		check_declaration_node(decl, status);
	}

	for (let func of trait.functions) {
		check_function_node(func, status);
	}

	status.type_params.length = type_params_length_before;
	status.types.length = types_length_before;
}
