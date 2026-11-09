import add_error from "../add_error.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import type FormatSpec from "../types/FormatSpec.ts";
import parse_expression from "./parse_expression.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import get_index from "./utils/get_index.ts";

// TODO: This should actually be calling a standard String.interpolate method with a params array

/** A format spec token emitted by the tokenizer: the `:` plus the raw spec
 *  text (`:.2`, `:>8`, `:08x` — or invalid text, which the strict grammar
 *  below reports). The tokenizer splits on ANY top-level `:` (none can occur
 *  in an ordinary expression; `::` namespace separators are excluded), so
 *  this accepts any colon-leading token, including a bare `:`. */
const FORMAT_SPEC_TOKEN = /^:/;

/** Strict grammar walk over the raw spec text (without the `:`). A spec
 *  containing `#` or `,` tries the simple grammar first, then the custom
 *  pattern grammar; everything else reports the simple-grammar failure. */
function parse_format_spec(
	text: string,
	start: number,
	status: ParseStatus,
): FormatSpec | undefined {
	const simple = parse_simple_spec(text, start);
	if (simple.spec) return simple.spec;
	// A COMBINATION failure (`:08n`, `:.2x`) is authoritative — the text IS
	// simple-shaped and simply rejected. A STRUCTURAL failure may still be
	// a valid custom pattern (`:00`, `:0.00`, `:#,##0`, …); when one exists
	// it wins, otherwise the error from whichever grammar the text belongs
	// to is reported.
	if (!simple.structural) {
		add_error(status, simple.error ?? "empty format spec", start);
		return undefined;
	}
	const pattern = parse_pattern_spec(text, start);
	if (pattern.spec) return pattern.spec;
	if (/[#,;%'"]/.test(text) || text.includes("E")) {
		add_error(status, pattern.error ?? "empty format spec", start);
	} else {
		add_error(status, simple.error ?? "empty format spec", start);
	}
	return undefined;
}

/** The simple spec grammar: `[fill][width][.precision][mode]`. Returns the
 *  spec, or an error plus whether the failure was STRUCTURAL (the text
 *  isn't simple-shaped at all — a custom pattern may still apply) versus a
 *  combination rule the simple grammar rejects outright. */
function parse_simple_spec(
	text: string,
	start: number,
): { spec?: FormatSpec; error?: string; structural?: boolean } {
	const spec: FormatSpec = { text, start };
	let i = 0;
	let filled = false;

	const read_digits = (): number | undefined => {
		const begin = i;
		while (i < text.length && text[i] >= "0" && text[i] <= "9") {
			i += 1;
		}
		if (i === begin) return undefined;
		return parseInt(text.substring(begin, i), 10);
	};

	if (text[i] === "<" || text[i] === ">") {
		spec.align = text[i] === "<" ? "left" : "right";
		i += 1;
		filled = true;
		const width = read_digits();
		if (width === undefined) {
			return {
				error: `invalid format spec ':${text}': expected width digits after '${spec.align === "left" ? "<" : ">"}'`,
			};
		}
		spec.width = width;
	} else if (text[i] === "0") {
		spec.zero = true;
		i += 1;
		filled = true;
		const width = read_digits();
		if (width === undefined) {
			return {
				error: `invalid format spec ':${text}': expected width digits after '0'`,
				structural: true,
			};
		}
		spec.width = width;
	}
	if (spec.width === undefined) {
		const width = read_digits();
		if (width !== undefined) {
			spec.width = width;
			filled = true;
		}
	}
	if (text[i] === ".") {
		i += 1;
		const precision = read_digits();
		if (precision === undefined) {
			return {
				error: `invalid format spec ':${text}': expected digits after '.'`,
				structural: true,
			};
		}
		spec.precision = precision;
		filled = true;
	}
	const BASE_LETTERS = "xXbo";
	const MODE_LETTERS = "xXbonNeE";
	if (i < text.length && MODE_LETTERS.includes(text[i]) && text.length - i === 1) {
		// A integer-base letter never takes a precision; grouping and
		// exponential do (`:.2n`, `:.3e`).
		spec.base = text[i] as FormatSpec["base"];
		i += 1;
		filled = true;
	}
	if (i < text.length) {
		return {
			error: `invalid format spec ':${text}': unexpected character '${text[i]}'`,
			structural: true,
		};
	}
	if (!filled) {
		return { error: "empty format spec", structural: true };
	}
	if (spec.precision !== undefined && spec.base && BASE_LETTERS.includes(spec.base)) {
		return { error: `invalid format spec ':${text}': precision and base cannot combine` };
	}
	if (spec.zero && spec.base && (spec.base === "n" || spec.base === "N")) {
		return { error: `invalid format spec ':${text}': zero-padding cannot combine with grouping` };
	}
	if (spec.width === 0) {
		return { error: `invalid format spec ':${text}': width must be at least 1` };
	}
	return { spec };
}

/** The custom-pattern grammar (C#-style subset — see FormatSpec). An
 *  optional `<N`/`>N` alignment prefix composes; the rest is the pattern,
 *  validated section by section. Returns the spec or the error message. */
function parse_pattern_spec(text: string, start: number): { spec?: FormatSpec; error?: string } {
	const spec: FormatSpec = { text, start };
	let i = 0;
	if (text[i] === "<" || text[i] === ">") {
		spec.align = text[i] === "<" ? "left" : "right";
		i += 1;
		const begin = i;
		while (i < text.length && text[i] >= "0" && text[i] <= "9") {
			i += 1;
		}
		if (i === begin) {
			return {
				error: `invalid format spec ':${text}': expected width digits after '${spec.align === "left" ? "<" : ">"}'`,
			};
		}
		spec.width = parseInt(text.substring(begin, i), 10);
		if (spec.width === 0) {
			return { error: `invalid format spec ':${text}': width must be at least 1` };
		}
	}
	const pattern = text.substring(i);
	if (pattern.length === 0) {
		return { error: "empty format spec" };
	}
	const failf = (message: string) => {
		return { error: `invalid format spec ':${text}': ${message}` };
	};

	// Validate the pattern: quote balance, at most two sections, and per
	// section at least one digit slot, at most one '.', commas only between
	// digit slots, and no exponential notation (use the `:e` spec).
	let quoted = false;
	let sections = 1;
	let section_has_slot = false;
	let section_dot = false;
	let slots_since_comma = -1;
	for (const c of pattern) {
		if (quoted) {
			if (c === "'") quoted = false;
			continue;
		}
		if (c === "'") {
			quoted = true;
			continue;
		}
		if (c === ";") {
			if (!section_has_slot) {
				return failf("each section needs at least one digit placeholder ('0' or '#')");
			}
			if (slots_since_comma === 0) {
				return failf("group commas must sit between digit placeholders");
			}
			sections += 1;
			if (sections > 2) {
				return failf("at most two ';'-separated sections");
			}
			section_has_slot = false;
			section_dot = false;
			slots_since_comma = -1;
			continue;
		}
		if (c === "E" || c === "e") {
			return failf("exponential patterns are not supported — use the ':e' spec");
		}
		if (c === ".") {
			if (section_dot) {
				return failf("at most one '.' per section");
			}
			section_dot = true;
			slots_since_comma = -1;
			continue;
		}
		if (c === "0" || c === "#") {
			section_has_slot = true;
			if (slots_since_comma >= 0) slots_since_comma += 1;
			continue;
		}
		if (c === ",") {
			if (!section_has_slot || section_dot || slots_since_comma === 0) {
				return failf("group commas must sit between digit placeholders");
			}
			slots_since_comma = 0;
			continue;
		}
	}
	if (quoted) {
		return failf("unbalanced pattern quotes");
	}
	if (!section_has_slot) {
		return failf("each section needs at least one digit placeholder ('0' or '#')");
	}
	if (slots_since_comma === 0) {
		return failf("group commas must sit between digit placeholders");
	}
	spec.pattern = pattern;
	return { spec };
}

export default function parse_string_interpolation(status: ParseStatus): FunctionCallNode {
	const start = get_index(status);

	let pattern = consume(status);
	let values = [];
	let specs: (FormatSpec | null)[] = [];
	let has_spec = false;

	while (true) {
		const value = consume(status);
		if (value === "\\{") {
			pattern += "\\{}";
			// A spec token straight after `\{` means `\{:8}` — no expression.
			const peeked = status.tokens[status.i];
			if (peeked && FORMAT_SPEC_TOKEN.test(peeked.value)) {
				add_error(
					status,
					`format spec '${peeked.value}' requires an expression before ':'`,
					peeked.i,
				);
				while (status.i < status.tokens.length && status.tokens[status.i].value !== "}") {
					status.i += 1;
				}
				accept("}", status);
				values.push(new ValueNode(start, '""', new Type("string", true)));
				specs.push(null);
				continue;
			}
			let param = parse_expression(status);
			// A format spec rides between the expression and the closing
			// brace: `\{expr:spec}`. Parse and VALIDATE the grammar now so
			// syntax errors surface even when the type checks never run.
			let spec: FormatSpec | null = null;
			const spec_token = status.tokens[status.i];
			if (spec_token && FORMAT_SPEC_TOKEN.test(spec_token.value)) {
				status.i += 1;
				const parsed = parse_format_spec(spec_token.value.substring(1), spec_token.i, status);
				if (parsed) {
					spec = parsed;
					has_spec = true;
				}
			}
			// Skip the wrap when the expression is ALREADY a `*.to_string()`
			// call: double-wrapping used to be harmless while the outer call
			// lowered to the `string_to_string` identity, but with the
			// signature flipped to `mv out string` (a real strdup) the inner
			// conversion's copy would leak between the two conversions.
			const already_to_string =
				param.node_type === "access" &&
				(param as AccessNode).access.node_type === "access_func" &&
				((param as AccessNode).access as AccessFunctionCallNode).name === "to_string";
			if (!already_to_string) {
				param = new AccessNode(
					start,
					param,
					new AccessFunctionCallNode(start, "to_string" /*, new Type("string", true)*/),
				);
			}
			values.push(param);
			specs.push(spec);
			accept("}", status);
		} else if (value.endsWith('"')) {
			pattern += value;
			break;
		} else {
			pattern += value;
		}
	}

	// HACK: This should be done in build
	pattern = pattern.replaceAll("\\{}", "%s");

	const call = new FunctionCallNode(
		start,
		`_string_interpolate_${values.length}`,
		new Type("string"),
		[new ValueNode(0, pattern, new Type("string", true)), ...values],
	);
	if (has_spec) {
		call.format_specs = specs;
	}
	return call;
}
