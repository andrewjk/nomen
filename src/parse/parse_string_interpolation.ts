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

/** Strict grammar walk over the raw spec text (without the `:`). Returns the
 *  spec, or undefined after reporting the syntax error. */
function parse_format_spec(
	text: string,
	start: number,
	status: ParseStatus,
): FormatSpec | undefined {
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
			add_error(
				status,
				`invalid format spec ':${text}': expected width digits after '${spec.align === "left" ? "<" : ">"}'`,
				start,
			);
			return undefined;
		}
		spec.width = width;
	} else if (text[i] === "0") {
		spec.zero = true;
		i += 1;
		filled = true;
		const width = read_digits();
		if (width === undefined) {
			add_error(status, `invalid format spec ':${text}': expected width digits after '0'`, start);
			return undefined;
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
			add_error(status, `invalid format spec ':${text}': expected digits after '.'`, start);
			return undefined;
		}
		spec.precision = precision;
		filled = true;
	}
	if (text[i] === "x" || text[i] === "X" || text[i] === "b" || text[i] === "o") {
		spec.base = text[i] as FormatSpec["base"];
		i += 1;
		filled = true;
	}
	if (i < text.length) {
		add_error(status, `invalid format spec ':${text}': unexpected character '${text[i]}'`, start);
		return undefined;
	}
	if (!filled) {
		add_error(status, "empty format spec", start);
		return undefined;
	}
	if (spec.precision !== undefined && spec.base) {
		add_error(status, `invalid format spec ':${text}': precision and base cannot combine`, start);
		return undefined;
	}
	if (spec.width === 0) {
		add_error(status, `invalid format spec ':${text}': width must be at least 1`, start);
		return undefined;
	}
	return spec;
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
