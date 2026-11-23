import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import BranchNode from "../nodes/BranchNode.ts";
import { is_returning_node } from "../nodes/check_node_type.ts";
import LetNode from "../nodes/LetNode.ts";
import MatchNode from "../nodes/MatchNode.ts";
import type ReturningNode from "../nodes/ReturningNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import consume_name from "./utils/consume_name.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_match(status: ParseStatus): MatchNode {
	const match_start = get_index(status);
	accept("match", status);

	const value = parse_expression(status);

	expect("{", status);

	const match_node = new MatchNode(match_start, value);
	status.stack.push(match_node);

	while (accept("case", status)) {
		// `case _` is the catch-all arm — parsed into `else_branch` so the
		// checker and builders see the same node shape they always have. It
		// must be the last arm and appear at most once (both were syntactically
		// guaranteed by the old outside-the-braces spelling).
		if (peek_current(status) === "_") {
			const catchall_start = get_index(status);
			accept("_", status);
			const branch = parse_match_branch(status);
			if (match_node.else_branch) {
				add_error(status, "Only one 'case _' arm is allowed", catchall_start);
			} else if (branch) {
				match_node.else_branch = branch;
			}
			if (peek_current(status) === "case") {
				add_error(status, "'case _' must be the last arm", get_index(status));
			}
			continue;
		}
		const pattern = parse_match_case_pattern(status);
		const branch = parse_match_branch(status);
		if (branch) {
			match_node.cases.push({
				match_value: pattern.value,
				branch,
				params: pattern.params,
			});
		}
	}
	if (peek_current(status) === "else") {
		add_error(
			status,
			`'else' is not a match arm — the catch-all is 'case _ -> ...'`,
			get_index(status),
		);
	}

	expect("}", status);

	status.stack.pop();

	if (peek_current(status) === "else") {
		// The removed `match x { cases } else { ... }` spelling — the catch-all
		// lives inside the braces as `case _`.
		add_error(
			status,
			`match arms live inside the braces — the catch-all is 'case _ -> ...'`,
			get_index(status),
		);
		accept("else", status);
		parse_match_branch(status);
	}

	return match_node;
}

/**
 * `try expr catch { case .notfound -> ... }` — the error-side handler
 * (ERRORS.md). Parsed as a MatchNode carrying `from_try`: the arms are the
 * flat error cases, the success side is implicit (the value flows through),
 * and the checker synthesizes the success arm + lowers the flat arms into
 * the same generated matches `match` used to expose. Same arm grammar as
 * `match` (arrow and block branches, payload bindings, origin-qualified
 * cases in composed sets).
 */
export function parse_try(status: ParseStatus): MatchNode {
	const try_start = get_index(status);
	accept("try", status);

	const value = parse_expression(status);

	if (!accept("catch", status)) {
		add_error(status, `'try' needs a 'catch' block after the expression`, get_index(status));
	}

	expect("{", status);

	const match_node = new MatchNode(try_start, value);
	match_node.from_try = true;
	status.stack.push(match_node);

	while (accept("case", status)) {
		const pattern = parse_match_case_pattern(status);
		const branch = parse_match_branch(status);
		if (branch) {
			match_node.cases.push({
				match_value: pattern.value,
				branch,
				params: pattern.params,
			});
		}
	}

	expect("}", status);

	status.stack.pop();

	return match_node;
}

// Parse a match case pattern: an enum case reference (`.caseName`, `Enum.caseName`,
// or bare `caseName`) optionally followed by `(binding, binding, ...)` that binds
// the case's associated data to local names inside the branch.
function parse_match_case_pattern(status: ParseStatus): { value: BaseNode; params: string[] } {
	const start = get_index(status);
	let value: BaseNode;

	const first = peek_current(status);
	if (first === ".") {
		accept(".", status);
		const name = consume(status);
		value = new ValueNode(start, `.${name}`);
	} else if (first && /^[A-Z]/.test(first) && status.tokens[status.i + 1]?.value === ".") {
		// `Enum.caseName` — build an access node manually so the trailing
		// `(bindings)` is not consumed as a function call.
		const enum_name = consume(status);
		accept(".", status);
		const case_name = consume(status);
		const target = new ValueNode(start, enum_name);
		const access = new AccessFieldNode(start, case_name);
		value = new AccessNode(start, target, access);
	} else if (first && /^[A-Z]/.test(first) && status.tokens[status.i + 1]?.value === "(") {
		// `Enum(bindings)` — bind the WHOLE enum value (ERRORS_PLAN stage 5:
		// a flat error arm binding its member error, e.g. `case LoadError(err)`
		// in a composed-set match). The checker resolves the type-named head
		// against the matched Result's error side; without the rewrite it is
		// an ordinary unknown-value pattern.
		const enum_name = consume(status);
		value = new ValueNode(start, enum_name);
	} else {
		value = parse_expression(status);
	}

	const params: string[] = [];
	if (accept("(", status)) {
		if (peek_current(status) !== ")") {
			params.push(consume_name(status));
			while (accept(",", status)) {
				params.push(consume_name(status));
			}
		}
		expect(")", status);
	}

	return { value, params };
}

function parse_match_branch(status: ParseStatus): BranchNode | null {
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
