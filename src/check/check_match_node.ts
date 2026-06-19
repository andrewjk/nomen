import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import MatchNode from "../nodes/MatchNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
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
		const old_expected_type = status.expected_type;
		status.expected_type = match_type;
		check_node(match_case.match_value, status);
		status.expected_type = old_expected_type;
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

		if (value.declaration === "var" && !value.is_set) {
			let set_count = branch_statuses.filter((bs) => bs.values[i]?.is_set).length;
			if (set_count === branch_statuses.length && branch_statuses.length > 0) {
				value.is_set = true;
			}
		}
	}

	if (!match_node.else_branch) {
		check_exhaustiveness(match_node, match_type, status);
	}
}

function check_exhaustiveness(
	match_node: MatchNode,
	match_type: ReturnType<typeof type_from_value_node>,
	status: CheckStatus,
) {
	if (!match_type.name) return;

	const enum_node = status.enums.find((e) => e.name === match_type.name);
	if (enum_node) {
		const covered = new Set<string>();
		for (const match_case of match_node.cases) {
			const case_name = extract_enum_case_name(match_case.match_value, match_type.name);
			if (case_name) covered.add(case_name);
		}
		const missing = enum_node.cases.map((c) => c.name).filter((n) => !covered.has(n));
		if (missing.length > 0) {
			add_error(
				status,
				`Non-exhaustive match: missing cases ${missing.join(", ")}`,
				match_node.start,
			);
		}
		return;
	}

	if (match_type.name === "bool") {
		const covered = new Set<string>();
		for (const match_case of match_node.cases) {
			if (match_case.match_value.node_type === "value") {
				const val = (match_case.match_value as ValueNode).value;
				if (val === "true" || val === "false") covered.add(val);
			}
		}
		const missing: string[] = [];
		if (!covered.has("true")) missing.push("true");
		if (!covered.has("false")) missing.push("false");
		if (missing.length > 0) {
			add_error(
				status,
				`Non-exhaustive match: missing cases ${missing.join(", ")}`,
				match_node.start,
			);
		}
		return;
	}

	add_error(status, `Non-exhaustive match: missing else branch`, match_node.start);
}

function extract_enum_case_name(
	node: import("../nodes/BaseNode.ts").default,
	enum_name: string,
): string | null {
	if (node.node_type === "value") {
		const vn = node as ValueNode;
		if (vn.is_enum_shorthand && vn.value.startsWith(enum_name + "_")) {
			return vn.value.substring(enum_name.length + 1);
		}
	}
	if (node.node_type === "access") {
		const an = node as AccessNode;
		if (an.access.node_type === "access_field") {
			const af = an.access as AccessFieldNode;
			if (an.target.node_type === "value") {
				const target = an.target as ValueNode;
				if (target.value === enum_name) {
					return af.name;
				}
			}
		}
	}
	return null;
}
