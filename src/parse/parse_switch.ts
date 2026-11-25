import add_error from "../add_error.ts";
import BranchNode from "../nodes/BranchNode.ts";
import LetNode from "../nodes/LetNode.ts";
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
	// `=>` is the LAMBDA introducer, never a switch arm — name the fix and
	// recover as `->` (the one-line arm value) so the arm still yields.
	const fat_arrow = peek_current(status) === "=>" ? get_index(status) : undefined;
	if (fat_arrow !== undefined) {
		add_error(
			status,
			`'=>' introduces a lambda — use '->' for a one-line branch value, or 'return' for a function return`,
			fat_arrow,
		);
		accept("=>", status);
	}
	// Full `let`/`->` symmetry (see parse_match_branch): one-line arms take
	// `->`; `let` yields a block branch — recover as `->`.
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
