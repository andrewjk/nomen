import add_error from "../add_error.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import clone_status from "./utils/clone_status.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name from "./utils/type_name.ts";

export default function check_switch_node(switch_node: SwitchNode, status: CheckStatus) {
	status.stack.push(switch_node);

	let branch_statuses: CheckStatus[] = [];

	for (let switch_case of switch_node.cases) {
		check_node(switch_case.condition, status);
		const condition_type = type_from_value_node(switch_case.condition, status);
		if (type_name(condition_type) !== "bool") {
			add_error(
				status,
				`Switch case condition must be a bool, not ${type_name(condition_type)}`,
				switch_case.condition.start,
			);
		}

		let case_status = clone_status(status);
		check_block_node(switch_case.branch, case_status);
		branch_statuses.push(case_status);
	}

	if (switch_node.else_branch) {
		let else_status = clone_status(status);
		check_block_node(switch_node.else_branch, else_status);
		branch_statuses.push(else_status);
	}

	status.stack.pop();

	for (let [i, value] of status.values.entries()) {
		if (value.declaration === "const" && !value.is_set) {
			let set_count = branch_statuses.filter((bs) => bs.values[i]?.is_set).length;
			if (set_count === branch_statuses.length && branch_statuses.length > 0) {
				value.is_set = true;
			} else if (set_count > 0) {
				add_error(status, `Const set incompletely: ${value.name}`, switch_node.start);
			}
		}

		if (value.declaration === "var" && !value.is_set) {
			let set_count = branch_statuses.filter((bs) => bs.values[i]?.is_set).length;
			if (set_count === branch_statuses.length && branch_statuses.length > 0) {
				value.is_set = true;
			}
		}
	}

	if (!switch_node.else_branch) {
		const parent = status.stack.at(-1);
		if (parent && (parent.node_type === "declare" || parent.node_type === "assign")) {
			add_error(status, "Switch expression must have an else branch", switch_node.start);
		}
	}
}
