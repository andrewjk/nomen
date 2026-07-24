import TraitNode from "../nodes/TraitNode.ts";
import Type from "../nodes/Type.ts";
import build_node from "./build_node.ts";
import build_parameter_node from "./build_parameter_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";

export default function build_trait_node(node: TraitNode, status: BuildStatus) {
	// We only need to build a trait node if there are default functions
	//if (!node.functions.find((f) => f.has_body)) {
	//  return;
	//}

	// TODO: Only if top-level
	status.headers += `// Trait ${node.name}\n`;
	status.code += `// Trait ${node.name}\n`;

	// Declare the trait as an opaque struct (forward-declared in headers).
	// Trait-typed values in C are always POINTERS to this struct — either a
	// class instance (already heap-allocated) or a boxed value struct that
	// conforms to the trait. Function return types, parameter types, and
	// locals that reference a trait emit `struct <Trait> *` explicitly (see
	// build_struct_functions / build_parameter_node / c_param_decl), so the
	// typedef itself just needs to exist as an incomplete type. The full
	// struct body is never emitted — there are no trait-typed values stored
	// by value (they're always boxed behind a pointer).
	status.headers += `struct ${node.name};\n`;
	status.code += `typedef struct ${node.name}\n{\n`;
	status.code += `} ${node.name};\n`;

	// Build the trait's default functions
	for (let func of node.functions) {
		if (!func.has_body) {
			continue;
		}

		const old_self_is_ref = status.self_is_ref;
		const self_param = func.params[0]?.is_self_param ? func.params[0] : null;
		status.self_is_ref = !!self_param?.is_ref;

		// Define the function
		// HACK: Need to map names to types
		const func_start = status.code.length;
		status.code += `${c_type(func.return_type.name || "void")} ${node.name}_${func.name.replace(/#/g, "")}(`;
		for (let i = 0; i < func.params.length; i++) {
			if (i > 0) {
				status.code += ", ";
			}
			build_parameter_node(func.params[i], status);
		}
		status.code += `)`;

		// TODO: Only if top-level
		status.headers += `${status.code.substring(func_start)};\n`;

		status.code += `\n{\n`;

		// HACK: Dereference the `self` pointer arg to a local variable with a random name
		// (`_self` for now, but we could automate it)
		// Skip for `ref self` — mutations should propagate through the pointer directly
		if (func.params[0]?.is_self_param && !func.params[0]?.is_ref) {
			status.code += `struct ${node.name} _self = *self;\n`;
			if (!status.variable_types) status.variable_types = new Map();
			status.variable_types.set("_self", new Type(node.name));
		}
		for (let child of func.statements) {
			build_node(child, status, true);
		}
		status.code += `}\n`;
		status.self_is_ref = old_self_is_ref;
	}

	status.headers += "\n";
	status.code += "\n";
}
