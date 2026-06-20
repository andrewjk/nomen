import built_in_types from "../built_in_types.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessIndexNode from "../nodes/AccessIndexNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_access_node(node: AccessNode, status: BuildStatus) {
	// PERF:
	let target_type = type_from_value_node(node.target);
	if (!target_type?.name && node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		if (name === "self" && status.current_struct) {
			target_type = new Type(status.current_struct.name);
		} else if (status.variable_types?.has(name)) {
			target_type = status.variable_types.get(name)!;
		} else {
			const decl = status.scoped_declarations.findLast((d) => d.name === name);
			if (decl?.type?.name) {
				target_type = decl.type;
			}
		}
	}
	const trait = status.traits.find((t) => t.name === target_type.name);
	const enum_node = status.enums.find((e) => e.name === target_type.name);
	const bitset_node = status.bitsets.find((b) => b.name === target_type.name);

	switch (node.access.node_type) {
		case "access_field": {
			const access_field = node.access as AccessFieldNode;
			// Variadic param .length → hidden _name_len parameter
			if (
				target_type.is_array &&
				access_field.name === "length" &&
				node.target.node_type === "value" &&
				status.function_variadic_params?.has((node.target as ValueNode).value)
			) {
				status.code += `_${(node.target as ValueNode).value}_len`;
				return;
			}
			// HACK:
			if (target_type.is_array && access_field.name === "length") {
				const type = c_type(target_type.name);
				status.code += "(sizeof(";
				build_node(node.target, status);
				status.code += `) / sizeof(${type}))`;
				return;
			}
			if (enum_node) {
				const enum_case = enum_node.cases.find((c) => c.name === access_field.name);
				if (enum_case) {
					if (enum_node.has_associated_data) {
						status.code += `${enum_node.name}_${enum_case.name}_init()`;
					} else {
						status.code += `${enum_node.name}_${enum_case.name}`;
					}
					return;
				}
			}
			if (bitset_node) {
				if (bitset_node.cases.includes(access_field.name)) {
					status.code += `${bitset_node.name}_${access_field.name}`;
					return;
				}
			}
			if (trait) {
				// If the target is a trait, we need to call the get/set method
				const traitField = trait.fields.find((f) => f.name == access_field.name)!;
				// TODO: Cast to the correct function definition
				// TODO: Use the correct variable name
				// TODO: Pass parameters
				const type = c_type(traitField.type.name);
				const cast = `(${type}(*)(void *))`;
				status.code += `(${cast}_get_trait_func((void *)`;
				build_node(node.target, status);
				const trait_index = status.traits.indexOf(trait);
				const field_index = trait.functions.length + trait.fields.indexOf(traitField) * 2;
				status.code += `, ${trait_index}, ${field_index}))(`;
				build_node(node.target, status);
				status.code += `)`;
				break;
			} else {
				const target_value =
					node.target.node_type === "value" ? (node.target as ValueNode).value : "";
				const target_is_ref =
					(target_value !== "self" || status.self_is_ref) &&
					status.function_ref_params?.has(target_value);
				build_node(node.target, status);
				status.code += target_is_ref ? `->${access_field.name}` : `.${access_field.name}`;
			}
			break;
		}
		case "access_func": {
			const access_func = node.access as AccessFunctionCallNode;
			if (enum_node) {
				const enum_case = enum_node.cases.find((c) => c.name === access_func.name);
				if (enum_case) {
					status.code += `${enum_node.name}_${enum_case.name}_init(`;
					for (let i = 0; i < access_func.params.length; i++) {
						if (i > 0) {
							status.code += ", ";
						}
						build_node(access_func.params[i], status);
					}
					status.code += ")";
					break;
				}
			}
			if (
				access_func.name === "to_string" &&
				(status.enums.find((e) => e.name === target_type.name) ||
					status.bitsets.find((b) => b.name === target_type.name))
			) {
				status.code += `int_to_string(`;
				build_node(node.target, status);
				status.code += ")";
				break;
			}
			if (trait) {
				// If the target is a trait, we need to find the correct function to
				// call from the vtable
				const trait_func = trait.functions.find((f) => f.name == access_func.name)!;
				// TODO: Cast to the correct function definition
				// TODO: Use the correct variable name
				// TODO: Pass parameters
				const cast = "(char *(*)(void *))";
				status.code += `(${cast}_get_trait_func(`;
				build_node(node.target, status);
				const trait_index = status.traits.indexOf(trait);
				const func_index = trait.functions.indexOf(trait_func);
				status.code += `, ${trait_index}, ${func_index}))(`;
				build_node(node.target, status);
				status.code += `)`;
			} else {
				let method_type: Type | undefined = target_type;
				if (!method_type?.name && node.target.node_type === "access") {
					method_type = resolve_access_field_type(node.target as AccessNode, status);
				}
				const label =
					access_func.mangled_name ||
					`${method_type?.name || ""}_${access_func.name.replace(/#/g, "")}`;
				status.code += `${label}(`;
				if (!access_func.is_static) {
					// TODO: be more rigorous about this! Sometimes types should be passed by ref??
					if (!built_in_types.includes(method_type?.name || "")) {
						const target_value =
							node.target.node_type === "value" ? (node.target as ValueNode).value : "";
						const target_is_ref_param =
							(target_value !== "self" || status.self_is_ref) &&
							status.function_ref_params?.has(target_value);
						if (!target_is_ref_param) {
							status.code += "&";
						}
					}
					build_node(node.target, status);
				}
				for (let i = 0; i < access_func.params.length; i++) {
					if (!access_func.is_static || i > 0) {
						status.code += ", ";
					}
					const param_type = type_from_value_node(access_func.params[i]);
					if (
						status.structs.find((s) => s.name === param_type.name && !s.is_simple_type) ||
						status.traits.find((t) => t.name === param_type.name)
					) {
						const param_value =
							access_func.params[i].node_type === "value"
								? (access_func.params[i] as ValueNode).value
								: "";
						const param_is_ref_param =
							(param_value !== "self" || status.self_is_ref) &&
							status.function_ref_params?.has(param_value);
						if (!param_is_ref_param) {
							status.code += "&";
						}
					}
					build_node(access_func.params[i], status);
				}
				status.code += ")";
			}
			break;
		}
		case "access_index": {
			const access_index = node.access as AccessIndexNode;
			build_node(node.target, status);
			status.code += "[";
			build_node(access_index.index, status);
			status.code += "]";
			break;
		}
	}
}

function resolve_access_field_type(node: AccessNode, status: BuildStatus): Type | undefined {
	if (node.access.node_type !== "access_field") return undefined;
	const field_name = (node.access as AccessFieldNode).name;

	let base_type: Type | undefined;
	if (node.target.node_type === "value") {
		const name = (node.target as ValueNode).value;
		const vtype = (node.target as ValueNode).type;
		if (vtype?.name) {
			base_type = vtype;
		} else if (name === "self" && status.current_struct) {
			base_type = new Type(status.current_struct.name);
		} else if (status.variable_types?.has(name)) {
			base_type = status.variable_types.get(name);
		}
	} else if (node.target.node_type === "access") {
		base_type = resolve_access_field_type(node.target as AccessNode, status);
	}

	if (!base_type?.name) return undefined;
	const struct = status.structs.find((s) => s.name === base_type!.name && !s.is_simple_type);
	const field = struct?.fields.find((f) => f.name === field_name);
	return field?.type;
}
