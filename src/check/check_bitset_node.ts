import add_error from "../add_error.ts";
import BitsetNode from "../nodes/BitsetNode.ts";
import type CheckStatus from "./CheckStatus.ts";

export default function check_bitset_node(node: BitsetNode, status: CheckStatus) {
	for (let i = 0; i < node.cases.length; i++) {
		for (let j = i + 1; j < node.cases.length; j++) {
			if (node.cases[i] === node.cases[j]) {
				add_error(status, `Duplicate bitset case: ${node.cases[j]}`, node.start);
			}
		}
	}

	if (!status.types.includes(node.name)) {
		status.types.push(node.name);
	}
	if (!status.bitsets.find((b) => b.name === node.name)) {
		status.bitsets.push(node);
	}
}
