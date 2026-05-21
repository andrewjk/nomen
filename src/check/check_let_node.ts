import { is_returning_node } from "../nodes/check_node_type.ts";
import LetNode from "../nodes/LetNode.ts";
import type ReturningNode from "../nodes/ReturningNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_let_node(node: LetNode, status: CheckStatus) {
	let func: ReturningNode | null = null;
	for (let i = status.stack.length - 1; i >= 0; i--) {
		if (is_returning_node(status.stack[i])) {
			func = status.stack[i] as ReturningNode;
			break;
		}
	}

	const old_expected_type = status.expected_type;
	if (func?.return_type?.name && func.return_type.name !== "?") {
		status.expected_type = func.return_type;
	}

	if (!check_node(node.value, status)) {
		status.expected_type = old_expected_type;
		return;
	}
	status.expected_type = old_expected_type;

	node.type = type_from_value_node(node.value, status);

	if (func) {
		if (func.return_type.name) {
			if (func.return_type.name !== "?") {
				const value_type = type_from_value_node(node.value, status);
				const value_str = value_from_value_node(node.value);
				const error_pos = node.value.node_type === "grouped" ? node.start + 2 : node.value.start;
				check_type_and_value_match(
					func.return_type,
					value_type,
					value_str,
					status,
					error_pos,
					"return",
				);
				func.return_type.is_static = value_type.is_static;
			}
		} else {
			func.return_type = node.type;
		}
	}
}
