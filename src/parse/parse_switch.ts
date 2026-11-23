import add_error from "../add_error.ts";
import BranchNode from "../nodes/BranchNode.ts";
import { is_returning_node } from "../nodes/check_node_type.ts";
import LetNode from "../nodes/LetNode.ts";
import type ReturningNode from "../nodes/ReturningNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_switch(status: ParseStatus): SwitchNode {
	const switch_start = get_index(status);
	accept("switch", status);

	expect("{", status);

	const switch_node = new SwitchNode(switch_start);
	status.stack.push(switch_node);

	while (accept("case", status)) {
		// `case _` is the catch-all arm — parsed into `else_branch` so the
		// checker and builders see the same node shape they always have. It
		// must be the last arm and appear at most once (both were syntactically
		// guaranteed by the old outside-the-braces spelling).
		if (peek_current(status) === "_") {
			const catchall_start = get_index(status);
			accept("_", status);
			const branch = parse_case_branch(status);
			if (switch_node.else_branch) {
				add_error(status, "Only one 'case _' arm is allowed", catchall_start);
			} else if (branch) {
				switch_node.else_branch = branch;
			}
			if (peek_current(status) === "case") {
				add_error(status, "'case _' must be the last arm", get_index(status));
			}
			continue;
		}
		const condition = parse_expression(status);
		const branch = parse_case_branch(status);
		if (branch) {
			switch_node.cases.push({ condition, branch });
		}
	}
	if (peek_current(status) === "else") {
		add_error(
			status,
			`'else' is not a switch arm — the catch-all is 'case _ -> ...'`,
			get_index(status),
		);
	}

	expect("}", status);

	status.stack.pop();

	if (peek_current(status) === "else") {
		// The removed `switch { cases } else { ... }` spelling — the catch-all
		// lives inside the braces as `case _`.
		add_error(
			status,
			`switch arms live inside the braces — the catch-all is 'case _ -> ...'`,
			get_index(status),
		);
		accept("else", status);
		parse_case_branch(status);
	}

	return switch_node;
}

function parse_case_branch(status: ParseStatus): BranchNode | null {
	const is_return = accept("=>", status);
	if (is_return || accept("->", status)) {
		const branch_start = get_index(status);
		let value;
		if (accept("(", status)) {
			value = parse_expression(status);
			expect(")", status);
		} else {
			value = parse_expression(status);
		}

		const branch = new BranchNode(branch_start);
		if (is_return) {
			const ret = new ReturnNode(value.start, value);
			branch.statements.push(ret);
			for (let i = status.stack.length - 1; i >= 0; i--) {
				if (is_returning_node(status.stack[i])) {
					(status.stack[i] as ReturningNode).has_return = true;
					if (status.stack[i].node_type === "func") break;
				}
			}
		} else {
			branch.statements.push(new LetNode(value.start, value));
		}
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
