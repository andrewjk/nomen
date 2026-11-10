import type DeclarationNode from "../nodes/DeclarationNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import { boxed_param_signature, emit_ref_prologue } from "./build_function_node.ts";
import { emit, expr, stmt } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { init_label, js_name, method_label, type_label } from "./names.ts";

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
		return field.value ? `${name} = ${expr(field.value, status)}` : name;
	});
	// `$type` is the runtime method table (trait dispatch): a value knows its
	// concrete struct, so a trait-typed call site can find the method.
	const properties = [`$type: ${type_label(node.name)}`].concat(
		fields.map((field) => `${field.name}: ${js_name(field.name)}`),
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
}

function emit_method(struct: StructNode, func: FunctionNode, status: BuildStatus): void {
	const old_ref_params = status.ref_params;
	status.ref_params = new Set();
	const params = func.params.map((param) => boxed_param_signature(param, status)).join(", ");
	emit(status, `function ${method_label(struct.name, func.name)}(${params}) {`);
	status.indent += 1;
	for (const param of func.params) emit_ref_prologue(param, status);
	for (const statement of func.statements) stmt(statement, status);
	status.indent -= 1;
	emit(status, "}");
	status.ref_params = old_ref_params;
}
