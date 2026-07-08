import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import Type from "../nodes/Type.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";

export default function build_struct_body(node: StructNode, status: BuildStatus) {
	if (node.is_generic) return;
	if (node.is_simple_type) return;
	if (status.emitted_struct_bodies?.has(node.name)) return;
	status.emitted_struct_bodies?.add(node.name);

	// Emit the struct typedef (body only, no functions)
	status.code += `typedef struct ${node.name}\n{\n`;
	status.code += `void *_vt;\n`;
	// Fields from the struct
	for (let field of node.fields) {
		if (field.type.is_array && field.type.length) {
			// Fixed-size array field: e.g. char* items[2]
			status.code += `${field_c_type(field.type, status)} ${field.name}[`;
			if (field.type.length) {
				build_node(field.type.length, status);
			}
			status.code += `];\n`;
		} else {
			status.code += `${field_c_type(field.type, status)} ${field.name};\n`;
		}
	}
	// Default fields from traits
	for (let traitName of node.traits) {
		const trait = status.traits.find((n) => n.name === traitName) as TraitNode;
		if (trait) {
			for (let field of trait.fields.filter((f) => !node.fields.find((nf) => nf.name === f.name))) {
				status.code += `${field_c_type(field.type, status)} ${field.name};\n`;
			}
		}
	}
	status.code += `} ${node.name};\n`;
}

function field_c_type(type: Type, status: BuildStatus): string {
	// Monomorphize generic field types: `List<Animal>` → `List_Animal`.
	const mono_name = type.type_args?.length
		? `${type.name}_${type.type_args.map((t) => t.name).join("_")}`
		: type.name;
	// Non-simple struct types must use the `struct` tag (the typedef may not
	// be in scope yet, e.g. forward references between monomorphized structs).
	const struct_node = status.structs.find(
		(s) => s.name === mono_name && !s.is_simple_type && !s.is_generic,
	);
	if (struct_node) {
		// Class-typed fields are heap pointers, not embedded structs.
		return struct_node.is_class ? `struct ${mono_name} *` : `struct ${mono_name}`;
	}
	return c_type(type.name);
}
