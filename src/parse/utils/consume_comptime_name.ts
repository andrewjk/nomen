import add_error from "../../add_error.ts";
import type ParseStatus from "../ParseStatus.ts";
import consume from "./consume.ts";
import expect from "./expect.ts";
import get_index from "./get_index.ts";
import peek_current from "./peek_current.ts";

const SPLICE_HINT = "a '#' name splice takes a dotted binding path — #field.name";
const SEGMENT = /^[A-Za-z_]\w*$/;

/**
 * A comptime name splice — `#field.name` in a declaration/method/type NAME
 * position inside a `#for` arm (the stage-3 member generation and the
 * stage-6 declaration generation). The `#` puts the entry in the comptime
 * namespace (`#if`/`#for`/`#error`); what follows is a dotted path over the
 * loop binding (`field.name`, `field.type.name`). The path is stored
 * verbatim on the node (`comptime_name`); the expansion folds it through
 * the binding's comptime members and writes the resulting string into the
 * node's `name`.
 *
 * Names can also be TEMPLATES: a literal prefix glued to the splice
 * (`get_#field.name`), a braced splice with a glued suffix
 * (`#{field.name}_id` — the braces stop the word-char greedy path), or
 * mixed. Template encoding on the node: literal text with `#{path}`
 * markers; the expansion folds each path and concatenates.
 *
 * Returns the splice template when the current token starts one (a `#`, or
 * a word immediately followed by a `#`), or undefined when the next token
 * is an ordinary name (nothing consumed — the caller reads its name as
 * usual).
 */
export default function consume_comptime_name(status: ParseStatus): string | undefined {
	const first = status.tokens[status.i];
	if (!first) return undefined;
	const is_prefix = comptime_prefix_ahead(status);
	if (first.value !== "#" && !is_prefix) return undefined;
	const start = get_index(status);
	let template = "";
	// A leading literal prefix glues to the splice (`id_` in `id_#f.n`).
	if (is_prefix) {
		template += first.value;
		consume(status);
	}
	let saw_splice = false;
	let last_end = -1; // end offset of the last consumed splice token
	for (;;) {
		const hash = status.tokens[status.i];
		if (!hash || hash.value !== "#") break;
		if (saw_splice && hash.i !== last_end) break;
		consume(status); // #
		const open = status.tokens[status.i];
		let path: string;
		if (open && open.value === "{" && open.i === hash.i + 1) {
			// Braced — the exact path, so glued suffixes (`#{f.n}_id`) are
			// reachable despite the tokenizer's greedy word scan.
			consume(status); // {
			path = consume_comptime_name_path(status);
			if (!expect("}", status)) return template;
			const close = status.tokens[status.i - 1];
			last_end = close.i + close.value.length;
		} else {
			// Unbraced — the dotted path is greedy (word chars glue), so it
			// must be the template's tail.
			path = consume_comptime_name_path(status);
			const last = status.tokens[status.i - 1];
			last_end = last.i + last.value.length;
		}
		template += `#{${path}}`;
		saw_splice = true;
		// A glued literal continues the template (`_id` after the splice).
		const next = status.tokens[status.i];
		if (!next) break;
		if (!SEGMENT.test(next.value) || next.i !== last_end) break;
		template += next.value;
		consume(status);
		last_end = next.i + next.value.length;
	}
	if (!saw_splice) {
		add_error(status, SPLICE_HINT, start);
		return "";
	}
	return template;
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

/**
 * Whether a NAME position currently sits on a word immediately followed by
 * a `#` (zero gap): `id_#field.name` — a literal PREFIX glued to a splice.
 * Zero gap is the discriminator: `var int #field.name` (keyword, spaced)
 * is an ordinary leading splice, while `id_#field.name` (word, glued)
 * starts a prefix template.
 */
export function comptime_prefix_ahead(status: ParseStatus): boolean {
	const token = status.tokens[status.i];
	const next = status.tokens[status.i + 1];
	if (!token || !next) return false;
	if (!SEGMENT.test(token.value)) return false;
	if (next.value !== "#") return false;
	return next.i === token.i + token.value.length;
}
