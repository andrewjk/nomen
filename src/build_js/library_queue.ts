import { get_built_in_type } from "../built_in_types.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import { child_nodes } from "../nodes/child_nodes.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import {
	boxed_param_signature,
	emit_ref_prologue,
	param_signature,
} from "./build_function_node.ts";
import { emit, expr, stmt } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { init_label, js_name, method_label } from "./names.ts";

/**
 * On-demand lowering of System-library code written in plain Nomen.
 *
 * The JS runtime natively models the containers (List/Map/Set/Box/…) and I/O,
 * but much of the library — `Text.Regex`, `Text.Chars`, `Json`, … — is
 * ordinary Nomen over strings, arrays, and ints. Rather than hand-port those,
 * the backend emits the checked body of each referenced method, exactly like
 * user code. A library body that needs raw memory (`#arch`, `unsafe`, pointer
 * indexing, foreign calls, threads) becomes a loud `__unsupported` stub
 * instead of silently wrong code.
 */

/** Library types the JS runtime models directly; their code is never lowered
 *  generically (the native mapping handles their supported surface). */
const NATIVE_TYPES = new Set([
	"Array",
	"Box",
	"Buffer",
	"Console",
	"Format",
	"List",
	"Map",
	"Set",
	"String",
	"StringBuilder",
]);

/** Is this a library type we must not lower generically? */
export function is_native_library_type(name: string): boolean {
	if (NATIVE_TYPES.has(name)) return true;
	return !!get_built_in_type(name);
}

/** Queue a specific library method (only the one that is called). */
export function queue_library_method(
	struct: StructNode,
	func: FunctionNode,
	status: BuildStatus,
): void {
	if (status.emitted_library.has(func)) return;
	if (status.library_method_queue.some((entry) => entry.func === func)) return;
	status.library_method_queue.push({ struct, func });
}

/** Queue a library struct's constructor factory. */
export function queue_library_init(struct: StructNode, status: BuildStatus): void {
	if (status.emitted_library.has(struct)) return;
	if (status.library_init_queue.includes(struct)) return;
	status.library_init_queue.push(struct);
}

/** Queue a library free function. */
export function queue_library_function(func: FunctionNode, status: BuildStatus): void {
	if (func.is_generic) return;
	if (status.emitted_library.has(func)) return;
	if (status.library_function_queue.includes(func)) return;
	status.library_function_queue.push(func);
}

/** Find a struct method by name (and arity, so overloads resolve). */
export function library_method(
	struct: StructNode,
	name: string,
	arg_count: number,
	is_static: boolean,
): FunctionNode | undefined {
	const arity = is_static ? arg_count : arg_count + 1;
	const candidates = struct.functions.filter((f) => f.name === name && f.has_body);
	return (
		candidates.find((f) => f.params.length === arity) ??
		candidates.find((f) => f.params.length >= arity) ??
		candidates[0]
	);
}

/** The emitted JS label for a library method. Overloads (same name, different
 *  arity) get an arity suffix so the declarations stay distinct. */
export function library_method_label(struct: StructNode, func: FunctionNode): string {
	const overloads = struct.functions.filter((f) => f.name === func.name && f.has_body);
	if (overloads.length <= 1) return method_label(struct.name, func.name);
	return js_name(`${struct.name}_${func.name}_${func.params.length}`);
}

/** Emit every queued library declaration into `status.library_code`. The
 *  queue grows while bodies are emitted (a library body calls other library
 *  code), so this drains it to a fixed point. */
export function emit_library_queue(status: BuildStatus): void {
	const outer_code = status.code;
	const outer_indent = status.indent;
	status.code = "";
	status.indent = 0;

	while (
		status.library_init_queue.length ||
		status.library_method_queue.length ||
		status.library_function_queue.length
	) {
		const init = status.library_init_queue.shift();
		if (init) {
			if (!status.emitted_library.has(init)) {
				status.emitted_library.add(init);
				emit_library_init(init, status);
			}
			continue;
		}
		const entry = status.library_method_queue.shift();
		if (entry) {
			if (!status.emitted_library.has(entry.func)) {
				status.emitted_library.add(entry.func);
				emit_library_method(entry.struct, entry.func, status);
			}
			continue;
		}
		const func = status.library_function_queue.shift();
		if (!func) continue;
		if (status.emitted_library.has(func)) continue;
		status.emitted_library.add(func);
		emit_library_function(func, status);
	}

	status.library_code += status.code;
	status.code = outer_code;
	status.indent = outer_indent;
}

function emit_library_method(struct: StructNode, func: FunctionNode, status: BuildStatus): void {
	const label = library_method_label(struct, func);
	if (needs_raw_memory(func)) {
		emit(status, `function ${label}() { __unsupported(${JSON.stringify(`library ${label}`)}); }`);
		return;
	}

	const old_ref_params = status.ref_params;
	status.ref_params = new Set();
	const params = func.params.map((param) => boxed_param_signature(param, status)).join(", ");
	emit(status, `function ${label}(${params}) {`);
	status.indent += 1;
	for (const param of func.params) emit_ref_prologue(param, status);
	for (const statement of func.statements) stmt(statement, status);
	status.indent -= 1;
	emit(status, "}");
	status.ref_params = old_ref_params;
}

function emit_library_function(func: FunctionNode, status: BuildStatus): void {
	const label = js_name(func.name);
	if (needs_raw_memory(func)) {
		const params = func.params.map(param_signature).join(", ");
		emit(
			status,
			`function ${label}(${params}) { __unsupported(${JSON.stringify(`library ${label}`)}); }`,
		);
		return;
	}

	const old_ref_params = status.ref_params;
	status.ref_params = new Set();
	const params = func.params.map((param) => boxed_param_signature(param, status)).join(", ");
	emit(status, `function ${label}(${params}) {`);
	status.indent += 1;
	for (const param of func.params) emit_ref_prologue(param, status);
	for (const statement of func.statements) stmt(statement, status);
	status.indent -= 1;
	emit(status, "}");
	status.ref_params = old_ref_params;
}

/** Emit a library struct's constructor factory (no methods, no `$type`). */
export function emit_library_init(struct: StructNode, status: BuildStatus): void {
	const fields = struct.fields.filter((field) => !!field.name);
	const params = fields.map((field) => {
		const name = js_name(field.name);
		return field.value ? `${name} = ${expr(field.value, status)}` : name;
	});
	const properties = fields.map((field) => `${field.name}: ${js_name(field.name)}`);
	emit(status, `function ${init_label(struct.name)}(${params.join(", ")}) {`);
	status.indent += 1;
	emit(status, `return { ${properties.join(", ")} };`);
	status.indent -= 1;
	emit(status, "}");
}

/** Does this library body rely on constructs the JS backend cannot express
 *  (raw asm/C, unsafe pointer work, foreign functions, threads)? */
export function needs_raw_memory(node: BaseNode): boolean {
	if (UNSUPPORTED_NODE_TYPES.has(node.node_type)) return true;
	// A foreign call: the callee is a body-less `foreign func` declaration
	// (and the emitter would call the `foreign_*` C adapter, which JS lacks).
	if (node.node_type === "func_call") {
		const call = node as unknown as {
			name?: string;
			resolved_function?: { is_foreign?: boolean; has_body?: boolean };
		};
		if (call.name?.startsWith("foreign_")) return true;
		if (call.resolved_function?.is_foreign) return true;
		if (call.resolved_function && call.resolved_function.has_body === false) return true;
	}
	if (node.node_type === "access") {
		const access = (node as unknown as { access?: { name?: string } }).access;
		if (access?.name?.startsWith("foreign_")) return true;
	}
	for (const child of child_nodes(node)) {
		if (needs_raw_memory(child)) return true;
	}
	return false;
}

const UNSUPPORTED_NODE_TYPES = new Set(["raw", "unsafe", "spawn", "async_block", "class", "index"]);

/** The call text for a library method (used by the access builder). */
export function library_method_call(
	struct: StructNode,
	func: FunctionNode,
	target: BaseNode | undefined,
	args: string[],
	status: BuildStatus,
): string {
	queue_library_method(struct, func, status);
	const label = library_method_label(struct, func);
	if (target === undefined) return `${label}(${args.join(", ")})`;
	return `${label}(${[expr(target, status), ...args].join(", ")})`;
}
