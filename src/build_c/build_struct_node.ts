import { is_overloaded, mangled_label } from "../check/utils/function_overload.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import Type from "../nodes/Type.ts";
import build_node from "./build_node.ts";
import build_parameter_node from "./build_parameter_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";

export default function build_struct_node(node: StructNode, status: BuildStatus) {
	if (node.is_generic) return;

	// If it's an inbuilt type, only build its functions
	// That way we can add e.g. traits like Stringable to ints
	if (node.is_simple_type) {
		status.code += `// Struct ${node.name}\n`;
		build_struct_functions(node, status);
		status.code += "\n";
		return;
	}

	// TODO: Only if top-level
	status.headers += `// Struct ${node.name}\n`;
	status.code += `// Struct ${node.name}\n`;

	if (node.traits.length) {
		build_struct_traits(node, status);
	}

	// Declare the struct
	status.headers += `struct ${node.name};\n`;

	// Define the struct
	status.code += `typedef struct ${node.name}\n{\n`;
	status.code += `void *_vt;\n`;
	// Fields from the struct
	for (let field of node.fields) {
		status.code += `${c_type(field.type.name)} ${field.name};\n`;
	}
	// Default fields from traits
	for (let traitName of node.traits) {
		const trait = status.traits.find((n) => n.name === traitName) as TraitNode;
		if (trait) {
			for (let field of trait.fields.filter((f) => !node.fields.find((nf) => nf.name === f.name))) {
				status.code += `${c_type(field.type.name)} ${field.name};\n`;
			}
		}
	}
	status.code += `} ${node.name};\n`;

	const custom_init = node.functions.find((f) => f.name === "#init" && f.has_body);

	// Declare the constructor
	const ctor_params = custom_init
		? custom_init.params
				.filter((p) => !p.is_self_param)
				.map((p) => `${c_type(p.type.name)} ${p.name}`)
				.join(", ")
		: node.fields
				.filter((f) => f.value == null)
				.map((f) => `${c_type(f.type.name)} ${f.name}`)
				.join(", ");
	const ctor = `${node.name} ${node.name}_init(${ctor_params})`;
	status.headers += `struct ${ctor};\n`;

	if (custom_init) {
		// Custom init - build it as a regular function
		build_struct_functions(node, status);
	} else {
		// Auto-generated init
		const object_name = node.name.substring(0, 1).toLocaleLowerCase();
		status.code += `${ctor}\n{\n`;
		status.code += `${node.name} ${object_name};\n`;
		if (node.traits.length) {
			status.code += `${object_name}._vt = &_${node.name}_traits;\n`;
		}
		//status.code += ` *${object_name} = malloc(sizeof(${node.name}));`
		// Fields from the struct
		for (let field of node.fields) {
			status.code += `${object_name}.${field.name} = `;
			if (field.value) {
				build_node(field.value, status);
			} else {
				status.code += field.name;
			}
			status.code += ";\n";
		}
		// Default fields from traits
		for (let traitName of node.traits) {
			const trait = status.traits.find((n) => n.name === traitName) as TraitNode;
			if (trait) {
				for (let field of trait.fields.filter(
					(f) => !node.fields.find((nf) => nf.name === f.name),
				)) {
					// TODO: Set the value properly
					status.code += `${object_name}.${field.name}`;
					if (field.value) {
						status.code += " = ";
						build_node(field.value, status);
					}
					status.code += ";\n";
				}
			}
		}
		status.code += `return ${object_name};\n`;
		status.code += `}\n`;

		build_struct_functions(node, status);
	}

	status.headers += "\n";
	status.code += "\n";
}

function build_struct_traits(node: StructNode, status: BuildStatus) {
	// Build the vtable that points to the struct's traits' methods by index
	for (let traitName of node.traits) {
		// E.g. int* _Dog_Animal_vtable_[4];
		status.code += `void *_${node.name}_${traitName}_funcs[] = {`;
		const trait = status.traits.find((n) => n.name === traitName) as TraitNode;
		status.code += trait.functions
			.map(
				(f) =>
					`${node.functions.find((tf) => tf.name === f.name) !== undefined ? node.name : trait.name}_${f.name}`,
			)
			.join(", ");
		if (trait.functions.length && trait.fields.length) {
			status.code += ", ";
		}
		status.code += trait.fields
			.map((f) => `get_${node.name}_${f.name}, set_${node.name}_${f.name}`)
			.join(", ");
		status.code += `};\n`;
	}

	// Build the vtable that points to the above table by index
	// E.g. int* _Dog_vtable_[];
	status.code += `void *_${node.name}_traits[] = {`;
	status.code += status.traits
		.map((t) => {
			if (node.traits.includes(t.name)) {
				return `&_${node.name}_${t.name}_funcs`;
			} else {
				return "NULL";
			}
		})
		.join(", ");
	status.code += `};\n`;
}

function build_struct_functions(node: StructNode, status: BuildStatus) {
	// Build the struct's functions
	const old_current_struct = status.current_struct;
	status.current_struct = node;
	for (let func of node.functions) {
		if (func.name === "#init" && !func.has_body) {
			continue;
		}
		if (func.name === "#destroy") continue;

		const old_ref_params = status.function_ref_params;
		const old_self_is_ref = status.self_is_ref;
		status.function_ref_params = new Set<string>();
		const self_param = func.params[0]?.is_self_param ? func.params[0] : null;
		status.self_is_ref = !!self_param?.is_ref;
		for (let param of func.params) {
			const param_struct = status.structs.find((s) => s.name === param.type.name);
			const param_trait = status.traits.find((t) => t.name === param.type.name);
			if (
				param.is_self_param ||
				(param_struct && !param_struct.is_simple_type) ||
				param_trait ||
				param.declaration === "var" ||
				param.type.is_ref
			) {
				status.function_ref_params.add(param.name);
			}
		}

		// Define the function
		// HACK: Need to map names to types
		const func_start = status.code.length;
		const return_type = func.return_type.name || "void";
		const return_struct = status.structs.find((s) => s.name === return_type && !s.is_simple_type);
		if (return_struct) {
			status.code += `struct `;
		}
		const func_label_name = is_overloaded(node, func.name)
			? mangled_label(func, node.name)
			: `${node.name}_${func.name.replace(/#/g, "")}`;
		status.code += `${c_type(return_type)} ${func_label_name}(`;
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
		if (!node.is_simple_type && func.params[0]?.is_self_param && !func.params[0]?.is_ref) {
			status.code += `struct ${node.name} _self = *self;\n`;
			if (!status.variable_types) status.variable_types = new Map();
			status.variable_types.set("_self", new Type(node.name));
			status.variable_types.set("self", new Type(node.name));
		}
		for (let child of func.statements) {
			build_node(child, status, true);
		}
		status.code += `}\n`;
		status.function_ref_params = old_ref_params;
		status.self_is_ref = old_self_is_ref;
	}
	status.current_struct = old_current_struct;

	// Build functions to get and set the trait's fields
	// TODO: Maybe this would be better done with a map?
	for (let traitName of node.traits) {
		const trait = status.traits.find((n) => n.name === traitName) as TraitNode;
		for (let field of trait.fields) {
			const get_signature = `${c_type(field.type.name)} get_${node.name}_${field.name}(struct ${node.name} *self)`;
			status.headers += `${get_signature};\n`;
			status.code += `${get_signature} { return self->${field.name}; }\n`;
			const set_signature = `void set_${node.name}_${field.name}(struct ${node.name} *self, ${c_type(field.type.name)} value)`;
			status.headers += `${set_signature};\n`;
			status.code += `${set_signature} { self->${field.name} = value; }\n`;
		}
	}
}
