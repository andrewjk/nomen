import BitsetNode from "../nodes/BitsetNode.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume_name from "./utils/consume_name.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";

export default function parse_bitset(visibility: "pub" | "private", status: ParseStatus) {
	const start = get_index(status);
	accept(visibility, status);
	// Optional `strict` modifier between visibility and `bitset`
	// (`pub strict bitset Flags { ... }`) — mirrors parse_enum. Contextual, so
	// `strict` remains usable as a name elsewhere.
	const strict = accept("strict", status);
	accept("bitset", status);
	const name = consume_name(status);
	const node = new BitsetNode(start, visibility, name);
	node.strict = strict;

	if (expect("{", status)) {
		while (accept("case", status)) {
			node.cases.push(consume_name(status));
		}
		expect("}", status);

		add_to_parent(node, "Bitset", status);
	}
}
