import EnumNode from "../nodes/EnumNode.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type, { c_typedef_name } from "./utils/c_type.ts";

export default function build_enum_node(node: EnumNode, status: BuildStatus) {
	// Generic enums are templates — only their monomorphized forms (created
	// during check, registered as their own EnumNodes) have a concrete layout.
	if (node.is_generic) return;

	status.headers += `// Enum ${node.name}\n`;
	status.code += `// Enum ${node.name}\n`;

	if (node.has_associated_data) {
		build_tagged_union_enum(node, status);
	} else {
		build_simple_enum(node, status);
	}

	status.headers += "\n";
	status.code += "\n";
}

function build_simple_enum(node: EnumNode, status: BuildStatus) {
	// Emit the typedef enum only in the header (which the .m includes), so the
	// definition isn't duplicated between the two files. The typedef name is
	// mangled on GUI builds (MacTypes collision); the enum constants
	// (`Name_case`) are plain symbols, unaffected.
	status.headers += `typedef enum { ${node.cases.map((c) => `${node.name}_${c.name}`).join(", ")} } ${c_typedef_name(node.name)};\n`;
}

function build_tagged_union_enum(node: EnumNode, status: BuildStatus) {
	// Tagged-union enums: emit tag typedef + struct typedef only in the header
	// (the .m includes it), avoiding duplicate definitions across files. Both
	// the tag enum and the struct typedef names are mangled on GUI builds; the
	// struct TAG (`struct Foo`) and the case constants stay plain.
	status.headers += `typedef enum { ${node.cases.map((c) => `${node.name}_${c.name}`).join(", ")} } ${c_typedef_name(node.name + "_tag")};\n`;
	status.headers += `struct ${node.name};\n`;
	status.headers += `typedef struct ${node.name}\n{\n`;
	status.headers += `${c_typedef_name(node.name + "_tag")} tag;\n`;
	status.headers += `union {\n`;
	for (const c of node.cases) {
		status.headers += `struct { ${c.params.map((p) => `${c_type(p.type.name)} ${p.name}`).join("; ")}${c.params.length ? ";" : ""} } _${c.name};\n`;
	}
	status.headers += `} _data;\n`;
	status.headers += `} ${c_typedef_name(node.name)};\n`;

	for (const c of node.cases) {
		const ctor_params = c.params.map((p) => `${c_type(p.type.name)} ${p.name}`).join(", ");
		const ctor = `${c_typedef_name(node.name)} ${node.name}_${c.name}_init(${ctor_params})`;
		status.headers += `${ctor};\n`;
		status.code += `${ctor}\n{\n`;
		status.code += `${c_typedef_name(node.name)} r;\n`;
		status.code += `r.tag = ${node.name}_${c.name};\n`;
		for (const p of c.params) {
			status.code += `r._data._${c.name}.${p.name} = ${p.name};\n`;
		}
		status.code += `return r;\n`;
		status.code += `}\n`;
	}
}
