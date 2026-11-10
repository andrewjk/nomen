import emission_label from "../build_common/emission_label.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";

/**
 * JavaScript identifiers that Nomen allows as names but JS reserves (or that
 * would shadow a global the generated code relies on). Binding names go
 * through `js_name`; property names after `.` never do (JS allows reserved
 * words there).
 */
const JS_RESERVED = new Set([
	"arguments",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"eval",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"undefined",
	"var",
	"void",
	"while",
	"with",
	"yield",
]);

/** The emitted JS binding name for a Nomen identifier. `#` markers (the
 *  compiler's special names, e.g. `#init`) are stripped, and a name that JS
 *  reserves is prefixed with `$`. */
export function js_name(name: string): string {
	const base = name.replace(/#/g, "");
	return JS_RESERVED.has(base) ? `$${base}` : base;
}

/** The emitted JS name for a free/nested function (the checker's unique
 *  `label_name` when present, else the source name). */
export function function_label(func: FunctionNode | { name: string; label_name?: string }): string {
	return js_name(emission_label(func));
}

/** The emitted JS name for a struct method (`<Struct>_<method>`). */
export function method_label(struct_name: string, func_name: string): string {
	return js_name(`${struct_name}_${func_name}`);
}

/** The emitted JS name for a struct constructor factory. */
export function init_label(struct_name: string): string {
	return js_name(`${struct_name}_init`);
}

/** The emitted JS name for a struct's runtime method table (trait dispatch). */
export function type_label(struct_name: string): string {
	return js_name(`${struct_name}_type`);
}
