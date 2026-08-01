import ExtendNode from "../nodes/ExtendNode.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";

/**
 * Parse `extend struct Name { ... }` or `extend class Name { ... }`.
 *
 * The body holds method declarations only (parsed by `parse_statement`); the
 * check phase merges them into the named struct/class. `extend class` is
 * required for classes, `extend struct` for structs — the two cannot mix.
 */
export default function parse_extend(visibility: "pub" | "private", status: ParseStatus) {
	const start = get_index(status);
	accept(visibility, status);
	accept("extend", status);

	const is_class = accept("class", status);
	if (!is_class) {
		expect("struct", status);
	}

	const name = consume(status);
	const node = new ExtendNode(start, visibility, name, is_class);

	if (expect("{", status)) {
		status.stack.push(node);
		parse_statement(status);
		expect("}", status);
		status.stack.pop();

		add_to_parent(node, "Extend", status);
	}
}
