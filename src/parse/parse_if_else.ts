import add_error from "../add_error.ts";
import BranchNode from "../nodes/BranchNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import LetNode from "../nodes/LetNode.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

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
		// `else if` isn't supported (the docs push `switch` for chained
		// conditions) — say so instead of a bare `Expected {`, and absorb the
		// nested chain so the parse recovers without cascades. Only the first
		// else-if in a chain reports; the rest are the same mistake.
		let said_else_if = false;
		for (;;) {
			if (peek_current(status) === "if") {
				if (!said_else_if) {
					add_error(
						status,
						`'else if' isn't supported — use a 'switch' for chained conditions`,
						get_index(status),
					);
					said_else_if = true;
				}
				accept("if", status);
				parse_expression(status);
				const branch = parse_if_branch(status);
				if (branch && !if_else.else_branch) {
					if_else.else_branch = branch;
				}
				if (!accept("else", status)) break;
				continue;
			}
			const branch = parse_if_branch(status);
			if (branch && !if_else.else_branch) {
				if_else.else_branch = branch;
			}
			break;
		}
	}

	status.stack.pop();

	return if_else;
}

function parse_if_branch(status: ParseStatus): BranchNode | null {
	// `=>` is the LAMBDA introducer — never a branch. The old parser
	// substituted it for `return` here (an undocumented return-from-branch
	// form); name the fix and recover as `->` (the one-line branch value)
	// so the branch still yields.
	const fat_arrow = peek_current(status) === "=>" ? get_index(status) : undefined;
	if (fat_arrow !== undefined) {
		add_error(
			status,
			`'=>' introduces a lambda — use '->' for a one-line branch value, or 'return' for a function return`,
			fat_arrow,
		);
		accept("=>", status);
	}
	// Full `let`/`->` symmetry: `->` introduces a ONE-LINE branch value and
	// `let` yields a BLOCK branch's value (the twin of `return` in a lambda
	// body) — so `if x let "yes"` is not a spelling. Match/switch arms
	// already reject it; the error recovers by parsing the branch as `->`
	// so nothing downstream cascades.
	const let_start = peek_current(status) === "let" ? get_index(status) : undefined;
	if (let_start !== undefined) {
		add_error(
			status,
			`'let' yields a block branch — use '->' for a one-line branch value`,
			let_start,
		);
		accept("let", status);
	}
	if (fat_arrow !== undefined || let_start !== undefined || accept("->", status)) {
		const branch_start = get_index(status);
		let value;
		if (accept("(", status)) {
			value = parse_expression(status);
			expect(")", status);
		} else {
			value = parse_expression(status);
		}

		const branch = new BranchNode(branch_start);
		branch.statements.push(new LetNode(value.start, value));
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
