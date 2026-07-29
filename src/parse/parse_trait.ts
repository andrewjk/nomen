import TraitNode from "../nodes/TraitNode.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import expect_close_angle from "./utils/expect_close_angle.ts";
import get_index from "./utils/get_index.ts";

export default function parse_trait(visibility: "pub" | "private", status: ParseStatus) {
	const start = get_index(status);
	accept(visibility, status);
	accept("trait", status);
	const name = consume(status);
	const trait = new TraitNode(start, visibility, name);

	// Generic trait: `trait Viewable<T>` — type params may be referenced by
	// trait method/field signatures; conforming structs supply concrete args.
	if (accept("<", status)) {
		trait.type_params.push(consume(status));
		while (accept(",", status)) {
			trait.type_params.push(consume(status));
		}
		expect_close_angle(status);
	}

	if (expect("{", status)) {
		status.stack.push(trait);
		parse_statement(status);
		expect("}", status);
		status.stack.pop();

		add_to_parent(trait, "Trait", status);
	}
}
