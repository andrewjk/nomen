import ForLoopNode from "../nodes/ForLoopNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";

export default function parse_for_loop(status: ParseStatus) {
	const for_start = get_index(status);
	accept("for", status);
	const start = get_index(status);
	// `for ref x of arr` — mutable element access (copy-out/copy-back for
	// arrays). `for x of arr` is const by default.
	const item_is_ref = accept("ref", status);
	const value = consume(status);
	const item = new ValueNode(start, value);
	// TODO: index option?
	if (expect("of", status)) {
		const list = parse_expression(status);

		let update;
		if (accept(";", status)) {
			update = parse_expression(status);
		}

		if (expect("{", status)) {
			const for_loop = new ForLoopNode(for_start, item, list, undefined, update);
			for_loop.item_is_ref = item_is_ref;

			status.stack.push(for_loop);
			parse_statement(status);
			expect("}", status);
			status.stack.pop();

			add_to_parent(for_loop, "For loop", status);
		}
	}
}
