import BitsetNode from "../nodes/BitsetNode.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_bitset_node(node: BitsetNode, status: BuildStatus) {
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
