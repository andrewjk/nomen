import add_error from "../add_error.ts";
import EnumNode from "../nodes/EnumNode.ts";
import type CheckStatus from "./CheckStatus.ts";

export default function check_enum_node(node: EnumNode, status: CheckStatus) {
	for (let i = 0; i < node.cases.length; i++) {
		for (let j = i + 1; j < node.cases.length; j++) {
			if (node.cases[i].name === node.cases[j].name) {
				add_error(
					status,
					`Duplicate enum case: ${node.cases[j].name}`,
					node.cases[j].params[0]?.start || node.start,
				);
			}
		}
	}

	for (let c of node.cases) {
		for (let p of c.params) {
			if (!status.types.includes(p.type.name)) {
				add_error(status, `Unknown type: ${p.type.name}`, p.start);
			}
		}
	}

	if (!status.types.includes(node.name)) {
		status.types.push(node.name);
	}
	if (!status.enums.find((e) => e.name === node.name)) {
		status.enums.push(node);
	}
}
