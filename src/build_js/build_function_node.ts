import type FunctionNode from "../nodes/FunctionNode.ts";
import { capture_body, emit, stmt } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { function_label, js_name } from "./names.ts";

/** Emit a free or nested function declaration. */
export default function build_function_node(node: FunctionNode, status: BuildStatus): void {
	if (!node.has_body || node.is_generic) return;
	const old_ref_params = status.ref_params;
	status.ref_params = new Set();
	const params = node.params.map((param) => boxed_param_signature(param, status)).join(", ");
	emit(status, `function ${function_label(node)}(${params}) {`);
	status.indent += 1;
	for (const param of node.params) emit_ref_prologue(param, status);
	for (const statement of node.statements) stmt(statement, status);
	status.indent -= 1;
	emit(status, "}");
	status.ref_params = old_ref_params;
}

/** A `ref` non-self parameter is passed as a box (`{ v }`); the JS parameter
 *  takes the box name and the body's prologue copies the value in. `self` is
 *  already a reference (an object), so a `ref self` receiver passes normally. */
export function boxed_param_signature(
	param: { is_self_param?: boolean; is_ref?: boolean; name: string; type?: { is_ref?: boolean } },
	status: BuildStatus,
): string {
	if (is_ref_param(param)) {
		status.ref_params?.add(js_name(param.name));
		return `__ref_${js_name(param.name)}`;
	}
	return param_signature(param);
}

export function emit_ref_prologue(
	param: { is_self_param?: boolean; is_ref?: boolean; name: string; type?: { is_ref?: boolean } },
	status: BuildStatus,
): void {
	if (is_ref_param(param)) {
		emit(status, `let ${js_name(param.name)} = __ref_${js_name(param.name)}.v;`);
	}
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

/** A `ref` parameter other than the `self` receiver. The parser records `ref`
 *  on the type for ordinary parameters (`ref int x`) and on the parameter
 *  itself for `ref self`. */
function is_ref_param(param: {
	is_self_param?: boolean;
	is_ref?: boolean;
	type?: { is_ref?: boolean };
}): boolean {
	if (param.is_self_param) return false;
	return !!(param.is_ref || param.type?.is_ref);
}
