import type DeclarationNode from "../nodes/DeclarationNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import { boxed_param_signature, emit_ref_prologue } from "./build_function_node.ts";
import { emit, expr, stmt } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { init_body_label, init_label, js_name, method_label, type_label } from "./names.ts";
import { copy_if_value_struct } from "./types.ts";

/**
 * Emit a user struct: a constructor factory plus its methods.
 *
 *  - `P(a, b)` → `P_init(a, b)` returning a plain object `{ field: value }`
 *    (fields in declaration order; declared defaults become JS defaults);
 *  - `p.bump(x)` → `P_bump(p, x)` — `self` is the first JS parameter;
 *  - `#init`/`#destroy`/other `#`-named synthesized members are not emitted:
 *    construction is the factory, and the GC replaces destroy.
 */
export default function build_struct_node(node: StructNode, status: BuildStatus): void {
	if (node.is_generic) return;

	const fields = node.fields.filter((f) => !!f.name);
	const params = fields.map((field: DeclarationNode) => {
		const name = js_name(field.name);
		return field.value
			? `${name} = ${copy_if_value_struct(
					expr(field.value, status),
					field.value ? undefined : field.type?.name,
					status,
				)}`
			: name;
	});
	// `$type` is the runtime method table (trait dispatch): a value knows its
	// concrete struct, so a trait-typed call site can find the method.
	const properties = [`$type: ${type_label(node.name)}`].concat(
		fields.map(
			(field: DeclarationNode) =>
				`${field.name}: ${copy_if_value_struct(js_name(field.name), field.type?.name, status)}`,
		),
	);

	emit(status, `function ${init_label(node.name)}(${params.join(", ")}) {`);
	status.indent += 1;
	emit(status, `return { ${properties.join(", ")} };`);
	status.indent -= 1;
	emit(status, "}");

	const methods: string[] = [];
	for (const func of node.functions) {
		if (!func.has_body || func.is_generic) continue;
		if (func.name.startsWith("#")) continue;
		emit_method(node, func, status);
		methods.push(`${js_name(func.name)}: ${method_label(node.name, func.name)}`);
	}
	emit(status, `const ${type_label(node.name)} = { ${methods.join(", ")} };`);

	// `#init` bodies run from the constructor IIFE (see init_body_label); they
	// are not part of the method table.
	node.functions
		.filter((func) => func.name === "#init" && func.has_body && !func.is_generic)
		.forEach((func, index) => {
			emit_method(node, func, status, init_body_label(node.name, index));
		});
}

function emit_method(
	struct: StructNode,
	func: FunctionNode,
	status: BuildStatus,
	label?: string,
): void {
	const old_ref_params = status.ref_params;
	status.ref_params = new Set();
	const params = func.params.map((param) => boxed_param_signature(param, status)).join(", ");
	emit(status, `function ${label ?? method_label(struct.name, func.name)}(${params}) {`);
	status.indent += 1;
	for (const param of func.params) emit_ref_prologue(param, status);
	for (const statement of func.statements) stmt(statement, status);
	status.indent -= 1;
	emit(status, "}");
	status.ref_params = old_ref_params;
}

/** The literal for a freshly-constructed struct before its `#init` runs:
 *  declared field defaults, or the type's zero value. */
export function struct_zero_object(
	struct: StructNode,
	status: BuildStatus,
	include_type = true,
): string {
	const parts = include_type ? [`$type: ${type_label(struct.name)}`] : [];
	for (const field of struct.fields) {
		if (!field.name) continue;
		const value = field.value
			? copy_if_value_struct(expr(field.value, status), field.type?.name, status)
			: zero_value(field.type?.name ?? "");
		parts.push(`${field.name}: ${value}`);
	}
	return `{ ${parts.join(", ")} }`;
}

/** The same object with its `#init` body applied. Emited at the constructor
 *  call site (the checker resolved which overload runs). */
export function struct_init_expression(
	struct: StructNode,
	init_index: number,
	args: string[],
	status: BuildStatus,
): string {
	const args_text = args.length ? `, ${args.join(", ")}` : "";
	return `(() => { const __self = ${struct_zero_object(struct, status)}; ${init_body_label(
		struct.name,
		init_index,
	)}(__self${args_text}); return __self; })()`;
}

function zero_value(type_name: string): string {
	switch (type_name) {
		case "float":
		case "float32":
		case "float64":
		case "ufloat":
			return "0";
		case "bool":
			return "false";
		case "char":
			return '"\\u0000"';
		case "string":
			return '""';
		case "":
			return "undefined";
		default:
			if (type_name.startsWith("int") || type_name.startsWith("uint")) return "0n";
			return "null";
	}
}
