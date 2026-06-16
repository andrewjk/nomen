import BitsetNode from "../nodes/BitsetNode.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";

export default function parse_bitset(visibility: "pub" | "private", status: ParseStatus) {
	const start = get_index(status);
	accept(visibility, status);
	accept("bitset", status);
	const name = consume(status);
	const node = new BitsetNode(start, visibility, name);

	if (expect("{", status)) {
		while (accept("case", status)) {
			node.cases.push(consume(status));
		}
		expect("}", status);

		add_to_parent(node, "Bitset", status);
	}
}
