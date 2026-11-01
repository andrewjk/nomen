import add_error from "../add_error.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_while_loop(status: ParseStatus) {
	const while_start = get_index(status);
	accept("while", status);
	const condition = parse_expression(status);

	let update;
	if (accept(";", status)) {
		// The ';' INTRODUCES the update clause — it is not a statement
		// terminator, and the no-update form has its own spelling
		// (`while cond { }`), so a bare `while cond; { }` is malformed.
		// Name the actual problem: falling through to the body-brace expect
		// reports a misleading "Expected {" against the loop body.
		if (peek_current(status) === "{") {
			add_error(status, `Expected update clause after ';'`, get_index(status));
		} else {
			update = parse_expression(status);
		}
	}

	if (expect("{", status)) {
		const while_loop = new WhileLoopNode(while_start, condition, undefined, update);

		status.stack.push(while_loop);
		parse_statement(status);
		expect("}", status);
		status.stack.pop();

		add_to_parent(while_loop, "While loop", status);
	}
}
