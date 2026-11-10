import { is_int_literal, parse_int_literal_bigint } from "../int_literal.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import { expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { enum_case_value, find_enum_case } from "./enums.ts";
import { function_label, js_name } from "./names.ts";

/**
 * A Nomen string/char literal is stored as its raw source text (quotes and
 * escapes included). JS understands the same escapes (`\n`, `\t`, `\\`, `\"`),
 * so the inner text passes through; the only rewrite needed is a REAL newline
 * or tab (a Nomen multi-line string), which would terminate a JS string
 * literal early.
 */
function string_inner(raw: string): string {
	let out = "";
	for (const c of raw) {
		if (c === "\n") out += "\\n";
		else if (c === "\r") out += "\\r";
		else if (c === "\t") out += "\\t";
		else out += c;
	}
	return out;
}

/** Escape a bare `"` (a char literal like `'"'`) so the JS string is valid;
 *  an already-escaped `\"` is left alone. */
function escape_quotes(text: string): string {
	let out = "";
	let backslashes = 0;
	for (const c of text) {
		if (c === '"' && backslashes % 2 === 0) out += '\\"';
		else out += c;
		backslashes = c === "\\" ? backslashes + 1 : 0;
	}
	return out;
}

const FLOAT_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Emit an expression for a literal or identifier value. */
export default function build_value_node(node: ValueNode, status: BuildStatus): string {
	const value = node.value;
	// An enum shorthand case used as a value (`Res.ok` / `.err`, which the
	// checker flattens to `Res_ok`): a tag-only object literal.
	if ((node as unknown as { is_enum_shorthand?: boolean }).is_enum_shorthand) {
		const hit = find_enum_case(status.enums, value);
		if (hit) return enum_case_value(hit.enum_node, hit.case_index, [], status);
	}
	// A checker-hoisted temp: inline its initializer here (see BuildStatus).
	const allocation = status.allocations?.get(value);
	if (allocation) {
		if (!status.inlining) status.inlining = new Set();
		if (status.inlining.has(value)) return "undefined";
		status.inlining.add(value);
		const text = expr(allocation, status);
		status.inlining.delete(value);
		return `(${text})`;
	}
	if (value === "true" || value === "false") return value;
	if (value === "null") return "null";
	if (value === "self") return "self";
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return `"${escape_quotes(string_inner(value.slice(1, -1)))}"`;
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return `"${escape_quotes(string_inner(value.slice(1, -1)))}"`;
	}
	if (is_int_literal(value)) {
		const n = parse_int_literal_bigint(value);
		return n === null ? "0n" : `${n}n`;
	}
	if (FLOAT_LITERAL.test(value)) {
		return value.replace(/_/g, "");
	}
	// A generic library body's template constants. Only monomorphized clones
	// see these natively; the JS backend lowers the generic body as written.
	// JS has no ownership distinction, so the copying arms are correct, and
	// the size constants are only read inside raw bodies (never lowered).
	if (/^(?:T|TK|TV)_(?:TAKES_OWNERSHIP|IS_VALUE_STRUCT|NEEDS_STRDUP|FAT)$/.test(value))
		return "false";
	if (/^(?:T|TK|TV)_SIZE$/.test(value)) return "0n";
	// A reference to a nested function as a VALUE (`apply(plus1, 4)`): the
	// checker stamps the resolved FunctionNode so the reference uses the
	// unique emission label, not the bare source name.
	const resolved = (node as unknown as { resolved_function?: Parameters<typeof function_label>[0] })
		.resolved_function;
	if (resolved) return function_label(resolved);
	return js_name(value);
}
