import BitsetNode from "../nodes/BitsetNode.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_bitset_node(node: BitsetNode, status: BuildStatus) {
	// Idempotency guard, mirroring build_enum_node's emitted_enums: a bitset
	// can be pulled to root scope as a payload dependency of a monomorphized
	// enum before the function body declaring it is built.
	if (!status.emitted_bitsets) status.emitted_bitsets = new Set();
	if (status.emitted_bitsets.has(node.name)) return;
	status.emitted_bitsets.add(node.name);

	status.headers += `// Bitset ${node.name}\n`;
	status.code += `// Bitset ${node.name}\n`;

	status.headers += `typedef unsigned long ${node.name};\n`;
	status.code += `typedef unsigned long ${node.name};\n`;

	for (let i = 0; i < node.cases.length; i++) {
		const def = `#define ${node.name}_${node.cases[i]} (1 << ${i})`;
		status.headers += `${def}\n`;
		status.code += `${def}\n`;
	}

	status.headers += "\n";
	status.code += "\n";
}
