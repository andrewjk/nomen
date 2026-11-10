import type FunctionNode from "../nodes/FunctionNode.ts";
import { capture_body, emit, stmt } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { function_label, js_name } from "./names.ts";

/** Emit a free or nested function declaration. */
export default function build_function_node(node: FunctionNode, status: BuildStatus): void {
	if (!node.has_body || node.is_generic) return;
	const params = node.params.map(param_signature).join(", ");
	emit(status, `function ${function_label(node)}(${params}) {`);
	status.indent += 1;
	for (const statement of node.statements) stmt(statement, status);
	status.indent -= 1;
	emit(status, "}");
}

/** A JS parameter list entry: `self` keeps its name; every other Nomen name
 *  is sanitized. `ref`/`mv` are compile-time modifiers with no JS analogue. */
export function param_signature(param: { is_self_param?: boolean; name: string }): string {
	return param.is_self_param ? "self" : js_name(param.name);
}

/** A function LITERAL in expression position (`(x) => x * 2`, or a block-body
 *  lambda): a JS function expression. Captures are lexical — JS closures give
 *  the same shape the C backend builds environment structs for. */
export function build_function_expression(node: FunctionNode, status: BuildStatus): string {
	const params = node.params.map(param_signature).join(", ");
	const body = capture_body(status, () => {
		for (const statement of node.statements) stmt(statement, status);
	});
	return `function (${params}) {\n${body}${"\t".repeat(status.indent)}}`;
}
