import add_error from "../../add_error.ts";
import { RESERVED_WORDS } from "../../keywords.ts";
import type ParseStatus from "../ParseStatus.ts";
import consume from "./consume.ts";
import get_index from "./get_index.ts";
import peek_current from "./peek_current.ts";

const SPLICE_HINT = "a '#' name splice takes a dotted binding path — #field.name";
const SEGMENT = /^[A-Za-z_]\w*$/;

/**
 * A comptime name splice — `#field.name` in a declaration/method/type NAME
 * position inside a `#for` arm (the stage-3 member generation and the
 * stage-6 declaration generation). The `#` puts the entry in the comptime
 * namespace (`#if`/`#for`/`#error`); what follows is a dotted path over the
 * loop binding (`field.name`, `field.type.name`) — plain identifier
 * segments joined by dots. The path is stored verbatim on the node
 * (`comptime_name`); the expansion folds it through the binding's comptime
 * members and writes the resulting string into the node's `name`.
 *
 * Returns the splice path when the current token is `#` (consuming the
 * splice), or undefined when the next token is an ordinary name (nothing
 * consumed — the caller reads its name as usual).
 */
export default function consume_comptime_name(status: ParseStatus): string | undefined {
	if (peek_current(status) !== "#") return undefined;
	const start = get_index(status);
	consume(status); // #
	return consume_comptime_name_path(status, start);
}

/**
 * The path after an already-consumed `#` (the caller consumed the token as
 * a name — parse_function's keyword-lenient name position). Returns the
 * dotted path, or "" on a malformed splice (the error is reported here).
 */
export function consume_comptime_name_path(status: ParseStatus, start = get_index(status)): string {
	const segments: string[] = [];
	const first = status.tokens[status.i]?.value ?? "";
	if (!SEGMENT.test(first)) {
		add_error(status, SPLICE_HINT, start);
		return "";
	}
	segments.push(consume(status));
	while (peek_current(status) === ".") {
		consume(status); // .
		const segment = status.tokens[status.i]?.value ?? "";
		if (!SEGMENT.test(segment)) {
			add_error(status, SPLICE_HINT, start);
			return segments.join(".");
		}
		segments.push(consume(status));
	}
	return segments.join(".");
}

/** Reserved-word check for a spliced-in name, shared with the expansion. */
export function splice_name_reserved(name: string): boolean {
	return RESERVED_WORDS.has(name);
}
