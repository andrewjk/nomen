import BranchNode from "../nodes/BranchNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";

export default function parse_switch(status: ParseStatus): SwitchNode {
	const switch_start = get_index(status);
	accept("switch", status);

	expect("{", status);

	const switch_node = new SwitchNode(switch_start);
	status.stack.push(switch_node);

	while (accept("case", status)) {
		const condition = parse_expression(status);
		const branch = parse_case_branch(status);
		if (branch) {
			switch_node.cases.push({ condition, branch });
		}
	}

	if (accept("else", status)) {
		const else_branch = parse_case_branch(status);
		if (else_branch) {
			switch_node.else_branch = else_branch;
		}
	}

	expect("}", status);

	status.stack.pop();

	return switch_node;
}

function parse_case_branch(status: ParseStatus): BranchNode | null {
	if (accept("->", status)) {
		const branch_start = get_index(status);
		let value;
		if (accept("(", status)) {
			value = parse_expression(status);
			expect(")", status);
		} else {
			value = parse_expression(status);
		}

		const branch = new BranchNode(branch_start);
		branch.statements.push(new ReturnNode(value.start, value));
		return branch;
	}

	if (expect("{", status)) {
		const branch = new BranchNode(get_index(status));
		status.stack.push(branch);

		parse_statement(status);
		expect("}", status);

		status.stack.pop();
		return branch;
	}

	return null;
}
