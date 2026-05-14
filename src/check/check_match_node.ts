import add_error from "../add_error.ts";
import MatchNode from "../nodes/MatchNode.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import clone_status from "./utils/clone_status.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name from "./utils/type_name.ts";

export default function check_match_node(match_node: MatchNode, status: CheckStatus) {
	check_node(match_node.value, status);
	const match_type = type_from_value_node(match_node.value, status);

	status.stack.push(match_node);

	let branch_statuses: CheckStatus[] = [];

	for (let match_case of match_node.cases) {
		check_node(match_case.match_value, status);
		const case_type = type_from_value_node(match_case.match_value, status);
		if (match_type.name && case_type.name && match_type.name !== case_type.name) {
			add_error(
				status,
				`Match case type ${type_name(case_type)} does not match value type ${type_name(match_type)}`,
				match_case.match_value.start,
			);
		}

		let case_status = clone_status(status);
		check_block_node(match_case.branch, case_status);
		branch_statuses.push(case_status);
	}

	if (match_node.else_branch) {
		let else_status = clone_status(status);
		check_block_node(match_node.else_branch, else_status);
		branch_statuses.push(else_status);
	}

	status.stack.pop();

	for (let [i, value] of status.values.entries()) {
		if (value.declaration === "const" && !value.is_set) {
			let set_count = branch_statuses.filter((bs) => bs.values[i]?.is_set).length;
			if (set_count === branch_statuses.length && branch_statuses.length > 0) {
				value.is_set = true;
			} else if (set_count > 0) {
				add_error(status, `Const set incompletely: ${value.name}`, match_node.start);
			}
		}
	}

	if (!match_node.else_branch) {
		const parent = status.stack.at(-1);
		if (parent && (parent.node_type === "declare" || parent.node_type === "assign")) {
			add_error(status, "Match expression must have an else branch", match_node.start);
		}
	}
}
