import type { AsyncMode } from "../nodes/AsyncBlockNode.ts";
import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_async_block(status: ParseStatus) {
	const start = get_index(status);
	accept("async", status);

	// Optional: async(timeout: <expr>, mode: race) { ... }
	let timeout;
	let mode: AsyncMode | undefined;
	if (accept("(", status, false)) {
		accept("(", status);
		// Parse comma-separated `key: value` options.
		while (peek_current(status) !== ")" && peek_current(status) !== "") {
			const key = consume(status);
			if (!accept(":", status)) break;
			const value = parse_expression(status);
			if (key === "timeout") {
				timeout = value;
			} else if (key === "mode") {
				if (value && value.node_type === "value") {
					const v = (value as ValueNode).value;
					if (v === "race" || v === "all") {
						mode = v;
					}
				}
			}
			if (!accept(",", status)) break;
		}
		expect(")", status);
	}

	if (expect("{", status)) {
		const block = new AsyncBlockNode(start, [], timeout);
		block.mode = mode;
		status.stack.push(block);
		parse_statement(status);
		expect("}", status);
		status.stack.pop();

		add_to_parent(block, "Async block", status);
	}
}
