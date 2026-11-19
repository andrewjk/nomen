import add_error from "../../add_error.ts";
import type ParseStatus from "../ParseStatus.ts";
import consume from "./consume.ts";
import expect from "./expect.ts";
import get_index from "./get_index.ts";
import peek_current from "./peek_current.ts";

const SPLICE_HINT = "a '#' name splice is '#{dotted.path}' — e.g. #{field.name}";
const SEGMENT = /^[A-Za-z_]\w*$/;

/**
 * A comptime name splice — `#{field.name}` in a declaration/method/type
 * NAME position inside a `#for` arm (the stage-3 member generation and the
 * stage-6 declaration generation). The braces are REQUIRED: a splice is
 * always `#{dotted.path}` — an exact dotted path over the loop binding —
 * and every piece glued to it (zero gap, before or after) is literal
 * template text (`get_#{field.name}`, `#{field.name}_id`,
 * `pre_#{a.name}_post`). The unbraced spelling was removed deliberately:
 * an unbraced path is greedy (word chars glue into the last segment), so
 * `#field.name_id` silently read `name_id` as the segment — the braces
 * make the path exact and the template grammar one rule.
 *
 * The template is stored verbatim on the node (`comptime_name`, literal
 * text with `#{path}` markers); the expansion folds each path through the
 * binding's comptime members and concatenates into the node's `name`.
 *
 * Returns the splice template when the current token starts one (a `#{`
 * pair, or a word immediately followed by one), or undefined when the
 * next token is an ordinary name (nothing consumed — the caller reads its
 * name as usual).
 */
export default function consume_comptime_name(status: ParseStatus): string | undefined {
	const first = status.tokens[status.i];
	if (!first) return undefined;
	const starts_splice = first.value === "#";
	if (!starts_splice && !comptime_prefix_ahead(status)) return undefined;
	const start = get_index(status);
	let template = "";
	// A leading literal prefix glued to the splice (`id_#{f.n}`).
	if (comptime_prefix_ahead(status)) {
		template += first.value;
		consume(status);
	}
	let saw_splice = false;
	let last_end = -1; // end offset of the last consumed template piece
	for (;;) {
		const hash = status.tokens[status.i];
		if (!hash || hash.value !== "#") break;
		if (saw_splice && hash.i !== last_end) break; // further splices must be glued
		consume(status); // #
		const open = status.tokens[status.i];
		if (!open || open.value !== "{" || open.i !== hash.i + 1) {
			add_error(status, SPLICE_HINT, hash.i);
			return "";
		}
		consume(status); // {
		const path = consume_comptime_name_path(status);
		if (!expect("}", status)) return template;
		const close = status.tokens[status.i - 1];
		last_end = close.i + close.value.length;
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
 * The dotted path inside an open `#{ ... }` — exact segments joined by
 * dots, nothing greedy. Returns the path, or "" on a malformed splice
 * (the error is reported here).
 */
export function consume_comptime_name_path(status: ParseStatus): string {
	const segments: string[] = [];
	const first = status.tokens[status.i]?.value ?? "";
	if (!SEGMENT.test(first)) {
		add_error(status, SPLICE_HINT, get_index(status));
		return "";
	}
	segments.push(consume(status));
	while (peek_current(status) === ".") {
		consume(status); // .
		const segment = status.tokens[status.i]?.value ?? "";
		if (!SEGMENT.test(segment)) {
			add_error(status, SPLICE_HINT, get_index(status));
			return segments.join(".");
		}
		segments.push(consume(status));
	}
	return segments.join(".");
}

/**
 * Whether a NAME position currently sits on a word immediately followed
 * by a `#{` pair (zero gap throughout): `id_#{field.name}` — a literal
 * PREFIX glued to a splice. Zero gap is the discriminator: `var int
 * #{field.name}` (keyword, spaced) is a plain leading splice, while
 * `id_#{field.name}` (word, glued) starts a prefix template.
 */
export function comptime_prefix_ahead(status: ParseStatus): boolean {
	const token = status.tokens[status.i];
	const hash = status.tokens[status.i + 1];
	const open = status.tokens[status.i + 2];
	if (!token || !hash || !open) return false;
	if (!SEGMENT.test(token.value)) return false;
	if (hash.value !== "#" || open.value !== "{") return false;
	return hash.i === token.i + token.value.length && open.i === hash.i + 1;
}
