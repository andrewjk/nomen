import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";

export default function build_struct_body(node: StructNode, status: BuildStatus) {
	if (node.is_generic) return;
	if (node.is_simple_type) return;

	// Emit the struct typedef (body only, no functions)
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
}
