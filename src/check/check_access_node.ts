import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessIndexNode from "../nodes/AccessIndexNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import Type from "../nodes/Type.ts";
import check_function_call from "./check_function_call.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_access_node(node: AccessNode, status: CheckStatus): boolean {
	if (!check_node(node.target, status)) {
		return false;
	}

	const target_type = type_from_value_node(node.target, status);
	if (!target_type.name) {
		add_error(status, `Unknown target: ${value_from_value_node(node.target)}`, node.target.start);
		return false;
	}

	switch (node.access.node_type) {
		case "access_field": {
			return check_access_field_node(target_type, node.access as AccessFieldNode, status);
		}
		case "access_func": {
			return check_access_function_node(target_type, node.access as AccessFunctionCallNode, status);
		}
		case "access_index": {
			return check_access_index_node(target_type, node.access as AccessIndexNode, status);
		}
	}

	return true;
}

function check_access_field_node(
	target_type: Type,
	node: AccessFieldNode,
	status: CheckStatus,
): boolean {
	const struct = status.structs.find((s) => s.name === target_type.name);
	let field = struct?.fields.find((f) => f.name === node.name);
	if (!field) {
		// Are we accessing a field in a trait?
		const trait = status.traits.find((s) => s.name === target_type.name);
		if (trait) {
			field = trait?.fields.find((f) => f.name === node.name);
		}
	}
	if (!field) {
		// Are we accessing a field in a struct with a trait and a default value?
		const struct = status.structs.find((s) => s.name === target_type.name);
		if (struct) {
			for (let trait_name of struct.traits) {
				const trait = status.traits.find((s) => s.name === trait_name);
				if (trait) {
					field = trait.fields.find((f) => f.name === node.name && f.value);
					break;
				}
			}
		}
	}
	// HACK:
	if (!field) {
		// Are we accessing length in an array
		if (target_type.is_array && node.name === "length") {
			node.type = new Type("int");
			return true;
		}
	}
	if (field) {
		if (
			field.visibility === "priv" &&
			!status.structs.find((s) => s.name === target_type.name)?.privates_visible
		) {
			add_error(status, `Can't access priv field: ${node.name}`, node.start);
			return false;
		} else {
			node.type = field.type;
		}
	} else {
		add_error(status, `Field not found: ${node.name}`, node.start);
		return false;
	}

	return true;
}

function check_access_function_node(
	target_type: Type,
	node: AccessFunctionCallNode,
	status: CheckStatus,
): boolean {
	const struct = status.structs.find((s) => s.name === target_type.name);

	let func = struct?.functions.find((f) => f.name === node.name);

	if (!func) {
		// Are we accessing a func in a trait?
		const trait = status.traits.find((s) => s.name === target_type.name);
		if (trait) {
			func = trait.functions.find((f) => f.name === node.name);
		}
	}

	if (!func) {
		// Are we accessing a func in a struct with a trait and a default value?
		const struct = status.structs.find((s) => s.name === target_type.name);
		if (struct) {
			for (let trait_name of struct.traits) {
				const trait = status.traits.find((s) => s.name === trait_name);
				if (trait) {
					func = trait.functions.find((f) => f.name === node.name && f.has_body);
					break;
				}
			}
		}
	}

	// Make sure the function exists
	if (!func) {
		add_error(status, `Function not found: ${target_type.name}.${node.name}`, node.start);
		return false;
	}

	return check_function_call(node, status, func, target_type);
}

function check_access_index_node(
	target_type: Type,
	node: AccessIndexNode,
	status: CheckStatus,
): boolean {
	// Make sure the type can be indexed
	// TODO: Do this with an Indexable trait instead
	if (!target_type.is_array) {
		add_error(status, `Target not indexable: ${target_type.name}`, node.start);
		return false;
	}

	node.type = new Type(target_type.name, target_type.is_static);

	return check_node(node.index, status);
}
