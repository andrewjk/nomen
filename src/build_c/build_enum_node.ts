import EnumNode from "../nodes/EnumNode.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";

export default function build_enum_node(node: EnumNode, status: BuildStatus) {
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
	status.headers += `typedef enum { ${node.cases.map((c) => `${node.name}_${c.name}`).join(", ")} } ${node.name};\n`;
	status.code += `typedef enum {\n`;
	for (const c of node.cases) {
		status.code += `${node.name}_${c.name},\n`;
	}
	status.code += `} ${node.name};\n`;
}

function build_tagged_union_enum(node: EnumNode, status: BuildStatus) {
	status.headers += `typedef enum { ${node.cases.map((c) => `${node.name}_${c.name}`).join(", ")} } ${node.name}_tag;\n`;
	status.headers += `struct ${node.name};\n`;

	status.code += `typedef enum {\n`;
	for (const c of node.cases) {
		status.code += `${node.name}_${c.name},\n`;
	}
	status.code += `} ${node.name}_tag;\n`;

	status.code += `typedef struct ${node.name}\n{\n`;
	status.code += `${node.name}_tag tag;\n`;
	status.code += `union {\n`;
	for (const c of node.cases) {
		status.code += `struct { ${c.params.map((p) => `${c_type(p.type.name)} ${p.name}`).join("; ")}${c.params.length ? ";" : ""} } _${c.name};\n`;
	}
	status.code += `} _data;\n`;
	status.code += `} ${node.name};\n`;

	for (const c of node.cases) {
		const ctor_params = c.params.map((p) => `${c_type(p.type.name)} ${p.name}`).join(", ");
		const ctor = `${node.name} ${node.name}_${c.name}_init(${ctor_params})`;
		status.headers += `${ctor};\n`;
		status.code += `${ctor}\n{\n`;
		status.code += `${node.name} r;\n`;
		status.code += `r.tag = ${node.name}_${c.name};\n`;
		for (const p of c.params) {
			status.code += `r._data._${c.name}.${p.name} = ${p.name};\n`;
		}
		status.code += `return r;\n`;
		status.code += `}\n`;
	}
}
