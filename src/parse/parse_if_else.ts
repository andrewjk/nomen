import { is_returning_node } from "../nodes/check_node_type.ts";
import type ReturningNode from "../nodes/ReturningNode.ts";
import BranchNode from "../nodes/BranchNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import LetNode from "../nodes/LetNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";

export default function parse_if_else(status: ParseStatus): IfElseNode {
	const if_start = get_index(status);
	accept("if", status);
	const condition = parse_expression(status);

	const if_else = new IfElseNode(if_start, condition);
	status.stack.push(if_else);

	let if_branch = parse_if_branch(status);
	if (if_branch) {
		if_else.if_branch = if_branch;
	}

	if (accept("else", status)) {
		let else_branch = parse_if_branch(status);
		if (else_branch) {
			if_else.else_branch = else_branch;
		}
	}

	status.stack.pop();

	return if_else;
}

function parse_if_branch(status: ParseStatus): BranchNode | null {
	const is_return = accept("=>", status);
	if (is_return || accept("->", status) || accept("let", status)) {
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

	// Block syntax: { ... }
	if (expect("{", status)) {
		const if_branch = new BranchNode(get_index(status));
		status.stack.push(if_branch);

		parse_statement(status);
		expect("}", status);

		status.stack.pop();
		return if_branch;
	}

	return null;
}
