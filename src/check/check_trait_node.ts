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

	for (let decl of trait.fields) {
		if (decl.declaration === "var" && decl.type.name && is_class_type(decl.type.name, status)) {
			add_error(status, `class-type fields must use 'mov', not 'var'`, decl.start);
		}
		check_declaration_node(decl, status);
	}

	for (let func of trait.functions) {
		check_function_node(func, status);
	}
}
