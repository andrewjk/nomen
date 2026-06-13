import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessIndexNode from "../nodes/AccessIndexNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import Type from "../nodes/Type.ts";
import check_function_call from "./check_function_call.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import {
	find_function_by_params,
	is_overloaded,
	mangled_label,
} from "./utils/function_overload.ts";
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
			return check_access_function_node(
				target_type,
				node.target,
				node.access as AccessFunctionCallNode,
				status,
			);
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
	let struct = status.structs.find((s) => s.name === target_type.name);
	if (struct?.is_generic && target_type.type_args?.length) {
		const mono_name = target_type.name + "_" + target_type.type_args.map((t) => t.name).join("_");
		struct = status.structs.find((s) => s.name === mono_name) || struct;
	}
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
					if (field) break;
				}
			}
		}
	}
	// HACK:
	if (!field) {
		// Are we accessing an enum case?
		const enum_node = status.enums.find((e) => e.name === target_type.name);
		if (enum_node) {
			const enum_case = enum_node.cases.find((c) => c.name === node.name);
			if (enum_case) {
				node.type = new Type(target_type.name);
				return true;
			} else {
				if (enum_node.has_associated_data) {
					for (const c of enum_node.cases) {
						const param = c.params.find((p) => p.name === node.name);
						if (param) {
							node.type = param.type;
							return true;
						}
					}
				}
				add_error(status, `Unknown enum case: ${target_type.name}.${node.name}`, node.start);
				return false;
			}
		}
	}
	if (!field) {
		// Are we accessing a bitset case?
		const bitset_node = status.bitsets.find((b) => b.name === target_type.name);
		if (bitset_node) {
			if (bitset_node.cases.includes(node.name)) {
				node.type = new Type(target_type.name);
				return true;
			} else {
				add_error(status, `Unknown bitset case: ${target_type.name}.${node.name}`, node.start);
				return false;
			}
		}
	}
	if (!field) {
		// Are we accessing length in an array
		if (target_type.is_array && node.name === "length") {
			node.type = new Type("int");
			return true;
		}
	}
	if (!field) {
		const struct = status.structs.find((s) => s.name === target_type.name);
		const func = struct?.functions.find((f) => f.name === node.name);
		if (func) {
			const func_type = new Type("func");
			func_type.func_params = func.params;
			func_type.func_return_type = func.return_type;
			node.type = func_type;
			return true;
		}
	}
	if (!field) {
		const enum_node = status.enums.find((e) => e.name === target_type.name);
		if (enum_node && enum_node.has_associated_data) {
			for (const c of enum_node.cases) {
				const param = c.params.find((p) => p.name === node.name);
				if (param) {
					node.type = param.type;
					return true;
				}
			}
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
	target: BaseNode,
	node: AccessFunctionCallNode,
	status: CheckStatus,
): boolean {
	const struct = status.structs.find((s) => s.name === target_type.name);

	let func: FunctionNode | undefined;
	if (struct) {
		const arg_types = node.params.map((p) => type_from_value_node(p, status));
		func = find_function_by_params(struct.functions, node.name, arg_types);
	}

	if (!func) {
		func = struct?.functions.findLast((f) => f.name === node.name);
	}

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
					if (func) break;
				}
			}
		}
	}

	if (!func) {
		// Are we calling an enum case constructor?
		const enum_node = status.enums.find((e) => e.name === target_type.name);
		if (enum_node) {
			const enum_case = enum_node.cases.find((c) => c.name === node.name);
			if (enum_case) {
				node.type = new Type(target_type.name);
				node.is_static = true;

				for (let param of node.params) {
					check_node(param, status);
				}

				return true;
			}
		}
	}

	// Make sure the function exists
	if (!func) {
		// For enum/bitset types, delegate to_string to int
		if (
			node.name === "to_string" &&
			(status.enums.find((e) => e.name === target_type.name) ||
				status.bitsets.find((b) => b.name === target_type.name))
		) {
			const int_struct = status.structs.find((s) => s.name === "int");
			func = int_struct?.functions.find((f) => f.name === "to_string");
		}
	}
	if (!func) {
		add_error(status, `Function not found: ${target_type.name}.${node.name}`, node.start);
		return false;
	}

	if (struct && is_overloaded(struct, node.name)) {
		node.mangled_name = mangled_label(func, struct.name);
	}

	return check_function_call(node, status, func, target_type, value_from_value_node(target));
}

function check_access_index_node(
	target_type: Type,
	node: AccessIndexNode,
	status: CheckStatus,
): boolean {
	// Make sure the type can be indexed
	// TODO: Do this with an Indexable trait instead
	if (target_type.is_array) {
		node.type = new Type(target_type.name, target_type.is_static);
	} else if (target_type.name === "string") {
		node.type = new Type("char");
	} else {
		add_error(status, `Target not indexable: ${target_type.name}`, node.start);
		return false;
	}

	return check_node(node.index, status);
}
