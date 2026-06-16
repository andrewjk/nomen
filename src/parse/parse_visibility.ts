import add_error from "../add_error.ts";
import parse_bitset from "./parse_bitset.ts";
import parse_declaration from "./parse_declaration.ts";
import parse_enum from "./parse_enum.ts";
import parse_function from "./parse_function.ts";
import parse_op from "./parse_op.ts";
import parse_struct from "./parse_struct.ts";
import parse_trait from "./parse_trait.ts";
import type ParseStatus from "./ParseStatus.ts";
import consume from "./utils/consume.ts";
import get_index from "./utils/get_index.ts";
import peek_next from "./utils/peek_next.ts";

export default function parse_visibility(visibility: "pub" | "private", status: ParseStatus) {
	// Declarations, funcs, structs and traits can have their visibility controlled
	// Visibility options are `pub` and `private`
	// `pub` is visible within the parent's scope (e.g. file, foler)
	// `private` is visible within the scope (e.g. function, file) only
	// Declarations, funcs, structs and traits have `private` visibility by default
	// Struct fields have `pub` visibility by default
	const next = peek_next(status);
	switch (next) {
		case "const":
		case "var": {
			if (visibility === "private" && status.stack.at(-1)?.node_type === "trait") {
				add_error(status, `Trait fields cannot be private`, get_index(status));
				consume(status);
			} else {
				parse_declaration(visibility, next, status);
			}
			break;
		}
		case "struct": {
			parse_struct(visibility, status);
			break;
		}
		case "class": {
			parse_struct(visibility, status, true);
			break;
		}
		case "enum": {
			parse_enum(visibility, status);
			break;
		}
		case "bitset": {
			parse_bitset(visibility, status);
			break;
		}
		case "trait": {
			parse_trait(visibility, status);
			break;
		}
		case "func": {
			if (visibility === "private" && status.stack.at(-1)?.node_type === "trait") {
				add_error(status, `Trait functions cannot be private`, get_index(status));
				consume(status);
			} else {
				parse_function(visibility, status);
			}
			break;
		}
		case "inline": {
			consume(status);
			if (peek_next(status) === "func") {
				parse_function(visibility, status, undefined, true);
			} else {
				add_error(status, "Expected func after inline", get_index(status));
			}
			break;
		}
		case "init": {
			consume(status);
			parse_function(visibility, status, "init");
			break;
		}

		case "op": {
			if (visibility === "private" && status.stack.at(-1)?.node_type === "trait") {
				add_error(status, `Trait operators cannot be private`, get_index(status));
				consume(status);
			} else {
				parse_op(visibility, status);
			}
			break;
		}
		default: {
			add_error(
				status,
				`Visibility can only be set for const, var, class, struct, trait or func`,
				get_index(status),
			);
			consume(status);
		}
	}
}
