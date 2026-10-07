import ExtendNode from "../nodes/ExtendNode.ts";
import parse_statement from "./parse_statement.ts";
import { parse_optional_trait_args } from "./parse_struct.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import class_retired_error from "./utils/class_retired_error.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

/**
 * Parse `extend struct Name { ... }`.
 *
 * The body holds method declarations only (parsed by `parse_statement`); the
 * check phase merges them into the named struct. `extend class` is retired
 * (STRUCT_PLAN_3 Phase R): it emits the one retirement error and continues
 * as a struct extend, since the declaration it names parses as an owning
 * struct too.
 *
 * An optional `: Trait1, Trait2` list after the name makes the target
 * conform to the listed traits out of line (Rust-style `impl Trait for
 * Type`). The check phase merges `traits` / `trait_args` into the target,
 * so conformance checking and vtable emission treat them exactly like
 * traits declared in the body. The required trait methods may be supplied
 * in this extend's body, another extend, or the original body.
 */
export default function parse_extend(
	visibility: "pub" | "private" | "internal",
	status: ParseStatus,
) {
	const start = get_index(status);
	accept(visibility, status);
	accept("extend", status);

	if (peek_current(status) === "class") {
		// STRUCT_PLAN_3 Phase R: `class` has retired — one clear error,
		// then the extend continues as a struct extend (the declaration
		// it names parses as an owning struct, so the check's target
		// match holds).
		class_retired_error(status);
	} else {
		expect("struct", status);
	}

	const name = consume(status);
	const node = new ExtendNode(start, visibility, name);

	if (accept(":", status)) {
		// Mirror parse_struct's conformance list: each entry is a trait name
		// optionally followed by concrete type args. The base name lives in
		// `traits` (vtable dispatch key); args land in the parallel
		// `trait_args` array and are arity-checked during check.
		node.traits.push(consume(status));
		node.trait_args.push(parse_optional_trait_args(status));
		while (accept(",", status)) {
			node.traits.push(consume(status));
			node.trait_args.push(parse_optional_trait_args(status));
		}
	}

	if (expect("{", status)) {
		status.stack.push(node);
		parse_statement(status);
		expect("}", status);
		status.stack.pop();

		add_to_parent(node, "Extend", status);
	}
}
