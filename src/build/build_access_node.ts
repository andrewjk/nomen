import built_in_types from "../built_in_types.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessIndexNode from "../nodes/AccessIndexNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_access_node(node: AccessNode, status: BuildStatus) {
	// PERF:
	const target_type = type_from_value_node(node.target);
	const trait = status.traits.find((t) => t.name === target_type.name);
	const enum_node = status.enums.find((e) => e.name === target_type.name);
	const bitset_node = status.bitsets.find((b) => b.name === target_type.name);

	switch (node.access.node_type) {
		case "access_field": {
			const access_field = node.access as AccessFieldNode;
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
				// If the target is a struct, we can just access the field directly
				build_node(node.target, status);
				status.code += `.${access_field.name}`;
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
				// If the target is a struct, we need to convert the access function
				// into a C function that takes the struct as an argument
				status.code += `${target_type.name}_${access_func.name}(`;
				if (!access_func.is_static) {
					// TODO: be more rigorous about this! Sometimes types should be passed by ref??
					if (!built_in_types.includes(target_type.name)) {
						status.code += "&";
					}
					build_node(node.target, status);
				}
				for (let i = 0; i < access_func.params.length; i++) {
					if (!access_func.is_static || i > 0) {
						status.code += ", ";
					}
					build_node(access_func.params[i], status);
				}
				status.code += ")";
			}
			break;
		}
		case "access_index": {
			const access_index = node.access as AccessIndexNode;
			//if (trait) {
			//  // If the target is a trait, we need to call the get/set method
			//  const traitField = trait.fields.find((f) => f.name == access_field.name)!;
			//  // TODO: Cast to the correct function definition
			//  // TODO: Use the correct variable name
			//  // TODO: Pass parameters
			//  const type = c_type(traitField.type.name);
			//  const cast = `(${type}(*)(void *))`;
			//  status.code += `(${cast}_get_trait_func((void *)`;
			//  build_node(node.target, status);
			//  const trait_index = status.traits.indexOf(trait);
			//  const field_index = trait.functions.length + trait.fields.indexOf(traitField) * 2;
			//  status.code += `, ${trait_index}, ${field_index}))(`;
			//  build_node(node.target, status);
			//  status.code += `)`;
			//  break;
			//} else {
			// If the target is a struct, we can just access the field directly
			build_node(node.target, status);
			status.code += "[";
			build_node(access_index.index, status);
			status.code += "]";
			//}
			break;
		}
	}
}
