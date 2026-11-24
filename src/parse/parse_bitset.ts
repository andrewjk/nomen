import BitsetNode from "../nodes/BitsetNode.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";

export default function parse_bitset(
	visibility: "pub" | "private" | "internal",
	status: ParseStatus,
) {
	const start = get_index(status);
	accept(visibility, status);
	// Optional `checked` modifier between visibility and `bitset`
	// (`pub checked bitset Flags { ... }`) — mirrors parse_enum. Contextual, so
	// `checked` remains usable as a name elsewhere.
	const checked = accept("checked", status);
	accept("bitset", status);
	// Type names are allowed to be keywords — the name after `bitset` is
	// unambiguous (same exemption as the name after `func`).
	const name = consume(status);
	const node = new BitsetNode(start, visibility, name);
	node.checked = checked;

	if (expect("{", status)) {
		while (accept("case", status)) {
			// Case names are allowed to be keywords — the name after `case`
			// in a type body is unambiguous, and every use is dot-prefixed
			// (`Flags.read`, match/`&` checks) — same exemption as the names
			// after `func` and the type keywords.
			node.cases.push(consume(status));
		}
		expect("}", status);

		add_to_parent(node, "Bitset", status);
	}
}
