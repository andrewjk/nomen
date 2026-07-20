import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";

export default function parse_async_block(status: ParseStatus) {
	const start = get_index(status);
	accept("async", status);

	if (expect("{", status)) {
		const block = new AsyncBlockNode(start);
		status.stack.push(block);
		parse_statement(status);
		expect("}", status);
		status.stack.pop();

		add_to_parent(block, "Async block", status);
	}
}
