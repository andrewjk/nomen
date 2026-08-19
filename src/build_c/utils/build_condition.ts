import type BaseNode from "../../nodes/BaseNode.ts";
import build_node from "../build_node.ts";
import type BuildStatus from "../BuildStatus.ts";

/**
 * Build a controlling expression (an if/while/for condition or a switch-case
 * comparison) and emit it without redundant fully-wrapping outer parentheses.
 * The codegen wraps every binary operation in parens (build_default_binary),
 * so emitting the condition verbatim would read `if ((a == b))`, which clang
 * flags as -Wparentheses-equality ("equality comparison with extraneous
 * parentheses").
 */
export default function build_condition(node: BaseNode, status: BuildStatus) {
	const before = status.code.length;
	build_node(node, status);
	status.code =
		status.code.substring(0, before) + strip_outer_parens(status.code.substring(before));
}

/**
 * Strip outer paren layers that wrap the ENTIRE expression (the opening paren
 * matches only the final character). A layer is removed only when the inner
 * text does not start with `{` — a GCC/clang statement-expression
 * `({ ... })` must keep its wrapper to stay a valid expression. Parens
 * inside string/char literals can only make the scan conservative (they
 * unbalance the depth count, so nothing is stripped), never incorrect.
 */
export function strip_outer_parens(expr: string): string {
	let code = expr.trim();
	while (code.length > 1 && code.startsWith("(") && code.endsWith(")")) {
		let depth = 0;
		let wraps_whole = true;
		for (let i = 0; i < code.length; i++) {
			const ch = code[i];
			if (ch === "(") depth++;
			else if (ch === ")") {
				depth--;
				if (depth === 0 && i < code.length - 1) {
					wraps_whole = false;
					break;
				}
			}
		}
		if (!wraps_whole || depth !== 0) break;
		const inner = code.slice(1, -1).trim();
		if (inner.startsWith("{")) break;
		code = inner;
	}
	return code;
}
