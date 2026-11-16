import add_error from "../../add_error.ts";
import type AttributeMeta from "../../types/AttributeMeta.ts";
import type ParseStatus from "../ParseStatus.ts";
import accept from "./accept.ts";
import consume from "./consume.ts";
import expect from "./expect.ts";
import get_index from "./get_index.ts";
import peek_current from "./peek_current.ts";

/**
 * Attributes (stage 3, docs/COMPTIME_PLAN_2.md D1): a comma-separated list
 * of `@name` / `@name(arg)` items on the line(s) above a declaration —
 *
 *   @rename("user_name"), @sql_type("VARCHAR")
 *   pub var string user_name
 *
 * Attribute names are snake_case lookup keys (not symbols — nothing
 * resolves them as types or functions, which is why they read lowercase).
 * ONE value per attribute, a comptime literal (string / int / float /
 * bool); a bare `@deprecated` is a flag with zero values. Repeating the
 * same attribute name is an error — when a real multi-value case shows
 * up, the shape is repeated attributes plus an `attr_values` API, not
 * comma-packed arguments. String arguments keep their literal CONTENT
 * (quotes stripped, no escape processing).
 */
export default function parse_attributes(status: ParseStatus): AttributeMeta[] {
	const attrs: AttributeMeta[] = [];
	while (peek_current(status) === "@") {
		const start = get_index(status);
		consume(status); // @
		const name_token = status.tokens[status.i];
		if (!name_token || !/^[A-Za-z_]\w*$/.test(name_token.value)) {
			add_error(status, "Expected attribute name after @", get_index(status));
			break;
		}
		consume(status); // name
		const attr: AttributeMeta = { name: name_token.value, values: [], start };
		if (accept("(", status)) {
			const value_token = status.tokens[status.i];
			const value_start = get_index(status);
			if (!value_token || value_token.value === ")") {
				add_error(
					status,
					"Expected an attribute value (string, int, float or bool literal)",
					value_start,
				);
			} else {
				const text = value_token.value;
				if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
					attr.values.push({
						kind: "string",
						text: text.substring(1, text.length - 1),
						start: value_start,
					});
				} else if (/^-?\d+$/.test(text)) {
					attr.values.push({ kind: "int", text, start: value_start });
				} else if (/^-?\d+\.\d+$/.test(text)) {
					attr.values.push({ kind: "float", text, start: value_start });
				} else if (text === "true" || text === "false") {
					attr.values.push({ kind: "bool", text, start: value_start });
				} else {
					add_error(
						status,
						"Attribute arguments must be comptime literals (string, int, float or bool)",
						value_start,
					);
				}
				consume(status);
				if (accept(",", status)) {
					add_error(
						status,
						"One value per attribute — repeat the attribute for more values",
						get_index(status),
					);
				}
			}
			expect(")", status);
		}
		if (attrs.some((existing) => existing.name === attr.name)) {
			add_error(
				status,
				`Attribute '@${attr.name}' repeated — repeats are not supported (attr/has_attr read the first)`,
				start,
			);
		}
		attrs.push(attr);
		if (!accept(",", status)) break;
	}
	return attrs;
}

/**
 * The tokens that may legally follow an attribute list — the leading words
 * of an attr-capable declaration (struct, field or function). Anything
 * else is rejected right at the `@`, before the mis-attachment can spread.
 */
const ATTR_TARGETS = new Set([
	"pub",
	"private",
	"internal",
	"mv",
	"struct",
	"class",
	"trait",
	"func",
	"inline",
	"foreign",
	"const",
	"var",
	"view",
	"ref",
	"readonly",
]);

export function attributes_target_allowed(token: string | undefined): boolean {
	return token !== undefined && ATTR_TARGETS.has(token);
}

/** Consume (and clear) the pending attribute list attached by the `@` case. */
export function take_attributes(status: ParseStatus): AttributeMeta[] | undefined {
	const attrs = status.pending_attributes;
	status.pending_attributes = undefined;
	return attrs;
}
