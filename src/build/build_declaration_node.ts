import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import build_node from "./build_node.ts";
import build_parameter_node from "./build_parameter_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_declaration_node(node: DeclarationNode, status: BuildStatus) {
	// TODO: malloc() if it's on the heap

	// Function type declaration
	if (node.func_params) {
		build_function_type_declaration(node, status);
		return;
	}

	// HACK: Move the array part of a declaration after the variable name if applicable
	// If it's an array of traits, make it contain pointers
	if (
		node.type.is_array &&
		status.traits.find((t) => t.name === node.type.name) &&
		node.value &&
		node.value.node_type === "array"
	) {
		const array_values = node.value as ArrayValuesNode;
		// Support GCC by defining vars first
		const variables: string[] = [];
		let i = 1;
		for (let value of array_values.values) {
			const var_type = type_from_value_node(value);
			const var_name = `_${node.name}_${i}`;
			status.scoped_declarations.push(
				new DeclarationNode(node.start, node.visibility, node.declaration, var_name, var_type),
			);
			// HACK:
			status.code += `${c_type(var_type.name)} ${var_name} = `;
			build_node(value, status);
			status.code += ";\n";
			i += 1;
			variables.push(var_name);
		}

		// Then build the array
		status.code += `void *${node.name}[`;
		if (node.type.length) {
			build_node(node.type.length, status);
		}
		status.code += `] = {${variables.map((v) => `&${v}`).join(", ")}}`;
	} else {
		status.scoped_declarations.push(node);
		if (node.type?.name) {
			if (!status.variable_types) status.variable_types = new Map();
			status.variable_types.set(node.name, node.type);
		}

		status.code += `${c_type(node.type.name)} ${node.name}`;
		if (node.type.is_array) {
			status.code += `[`;
			if (node.type.length) {
				build_node(node.type.length, status);
			}
			status.code += `]`;
		}
		if (node.value) {
			// TODO: This should be in more places?? Or apply to more nodes?? Probably
			// in build_node -- if it's a returning node??
			if (node.value.node_type === "if") {
				status.code += ";\n";
				const old_return_assign = status.return_assign;
				status.return_assign = node.name;
				build_node(node.value, status);
				status.return_assign = old_return_assign;
			} else {
				status.code += " = ";
				build_node(node.value, status);
			}
		}
	}
}

function build_function_type_declaration(node: DeclarationNode, status: BuildStatus) {
	// If the value is a FunctionNode, build it as a regular function definition
	if (node.value && node.value.node_type === "func") {
		build_node(node.value, status);
		return;
	}

	// Otherwise, generate a function pointer declaration
	const return_type_name = node.func_return_type?.name || "void";
	status.code += `${c_type(return_type_name)} (*${node.name})(`;
	for (let i = 0; i < node.func_params!.length; i++) {
		if (i > 0) {
			status.code += ", ";
		}
		build_parameter_node(node.func_params![i], status);
	}
	status.code += `)`;
	if (node.value) {
		status.code += " = ";
		build_node(node.value, status);
	}
}
