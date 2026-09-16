import add_error from "../add_error.ts";
import parse_bitset from "./parse_bitset.ts";
import parse_declaration from "./parse_declaration.ts";
import parse_enum from "./parse_enum.ts";
import parse_extend from "./parse_extend.ts";
import parse_function from "./parse_function.ts";
import parse_struct from "./parse_struct.ts";
import parse_trait from "./parse_trait.ts";
import type ParseStatus from "./ParseStatus.ts";
import consume from "./utils/consume.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";
import peek_next from "./utils/peek_next.ts";

export default function parse_visibility(
	visibility: "pub" | "private" | "internal",
	status: ParseStatus,
) {
	// Declarations, funcs, structs and traits can have their visibility controlled
	// Visibility options are `pub`, `private`, and `internal`
	// `pub` is visible within the parent's scope (e.g. file, foler)
	// `private` is visible within the scope (e.g. function, file) only
	// `internal` is visible within the declaring module/library only
	// Declarations, funcs, structs and traits have `private` visibility by default
	// Struct fields have `pub` visibility by default
	const next = peek_next(status);
	switch (next) {
		case "const":
		case "var":
		case "move":
		case "view": {
			if (visibility !== "pub" && status.stack.at(-1)?.node_type === "trait") {
				add_error(status, `Trait fields cannot be ${visibility}`, get_index(status));
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
		case "extend": {
			parse_extend(visibility, status);
			break;
		}
		case "enum": {
			parse_enum(visibility, status);
			break;
		}
		case "must_use": {
			// `<visibility> must_use enum/bitset …` — the parse_* functions
			// consume the visibility, then the `must_use` modifier, then the
			// kind keyword. Disambiguate on the token after `must_use`.
			const next2 = status.tokens[status.i + 2]?.value;
			if (next2 === "enum") {
				parse_enum(visibility, status);
			} else if (next2 === "bitset") {
				parse_bitset(visibility, status);
			} else {
				add_error(status, `Expected enum or bitset after must_use`, get_index(status));
				consume(status);
			}
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
			if (visibility !== "pub" && status.stack.at(-1)?.node_type === "trait") {
				add_error(status, `Trait functions cannot be ${visibility}`, get_index(status));
				consume(status);
			} else {
				parse_function(visibility, status);
			}
			break;
		}
		case "inline": {
			consume(status);
			// `<visibility> inline func …` — consume the `inline` marker too
			// (for the bare statement-level form, current is already `func`).
			if (peek_current(status) === "inline") {
				consume(status);
			}
			// `<visibility> inline unsafe func …` — the unsafe marker may sit
			// between the modifiers.
			let unsafe_fn = false;
			if (peek_current(status) === "unsafe") {
				consume(status);
				unsafe_fn = true;
			}
			if (peek_current(status) === "func") {
				parse_function(visibility, status, undefined, true, false, unsafe_fn);
			} else {
				add_error(status, "Expected func after inline", get_index(status));
			}
			break;
		}
		case "extern": {
			consume(status);
			// `<visibility> extern func …` — a body-less declaration whose
			// body is a C-library symbol call. Library-only (checker-enforced).
			if (peek_current(status) === "func") {
				parse_function(visibility, status, undefined, false, true);
			} else {
				add_error(status, "Expected func after extern", get_index(status));
			}
			break;
		}
		case "unsafe": {
			consume(status);
			// `<visibility> unsafe func …` — the whole body is an unsafe
			// context (ptr values, indexing, pointer casts). Library-only:
			// the lockdown boundary check runs in parse_function.
			if (peek_current(status) === "unsafe") {
				consume(status);
			}
			if (peek_current(status) === "inline") {
				consume(status);
				if (peek_current(status) === "func") {
					parse_function(visibility, status, undefined, true, false, true);
				} else {
					add_error(status, "Expected func after inline", get_index(status));
				}
				break;
			}
			if (peek_current(status) === "func") {
				parse_function(visibility, status, undefined, false, false, true);
			} else {
				add_error(status, "Expected func after unsafe", get_index(status));
			}
			break;
		}
		case "#": {
			const next2 = status.tokens[status.i + 2]?.value;
			if (next2 === "init") {
				consume(status); // consume pub
				consume(status); // consume #
				consume(status); // consume init
				parse_function(visibility, status, "#init");
			} else if (next2 === "destroy") {
				consume(status); // consume pub
				consume(status); // consume #
				consume(status); // consume destroy
				parse_function(visibility, status, "#destroy");
			} else {
				add_error(status, `Expected #init or #destroy after pub`, get_index(status));
				consume(status);
			}
			break;
		}

		default: {
			add_error(
				status,
				`Visibility can only be set for const, var, move, class, struct, trait or func`,
				get_index(status),
			);
			consume(status);
		}
	}
}
