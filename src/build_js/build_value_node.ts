import { is_int_literal, parse_int_literal_bigint } from "../int_literal.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import type BuildStatus from "./BuildStatus.ts";
import { js_name } from "./names.ts";

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

const FLOAT_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Emit an expression for a literal or identifier value. */
export default function build_value_node(node: ValueNode, status: BuildStatus): string {
	void status;
	const value = node.value;
	if (value === "true" || value === "false") return value;
	if (value === "null") return "null";
	if (value === "self") return "self";
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return `"${string_inner(value.slice(1, -1))}"`;
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return `"${string_inner(value.slice(1, -1))}"`;
	}
	if (is_int_literal(value)) {
		const n = parse_int_literal_bigint(value);
		return n === null ? "0n" : `${n}n`;
	}
	if (FLOAT_LITERAL.test(value)) {
		return value.replace(/_/g, "");
	}
	return js_name(value);
}
