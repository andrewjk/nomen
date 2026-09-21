import emission_label from "../../build_common/emission_label.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import type Type from "../../nodes/Type.ts";
import build_function_node from "../build_function_node.ts";
import build_parameter_node from "../build_parameter_node.ts";
import type BuildStatus from "../BuildStatus.ts";
import c_function_name from "./c_function_name.ts";
import c_type from "./c_type.ts";
import { emit_closure_env_free, emit_closure_env_type } from "./closure_env.ts";

/**
 * Closure descriptor ABI (CLOSURE.md). A func-typed VALUE is a
 * `struct nomen_closure *` — { code, env, owned }:
 *
 *   - `code` always has the closure ABI (`Ret code(void *env, Args...)`).
 *     Lambdas are emitted with the hidden env parameter directly; a named
 *     function used as a value gets an auto-generated thunk that forwards.
 *   - `env` is NULL for capture-free values (Phase 1 — there are no
 *     captures yet).
 *   - `owned` is 0 for the static descriptors materialized here (never
 *     freed); Phase 2's capturing closures allocate heap descriptors with
 *     `owned = 1`, which the free-if-owned destroy arms release.
 *
 * Signatures never change: func-typed params/fields/locals/returns stay one
 * word. Only indirect calls grow the leading env argument.
 */

/** The descriptor struct is defined in the header preamble (build_root_node)
 *  — it must precede every prototype, since a tag first appearing inside a
 *  prototype has prototype scope in C. This just initializes the memo map. */
export function ensure_closure_runtime(status: BuildStatus): void {
	if (status.closure_runtime_emitted) return;
	status.closure_runtime_emitted = true;
	if (!status.closure_descriptors) status.closure_descriptors = new Map();
}

/**
 * The C type for one parameter of a function's signature, built through the
 * real parameter emitter (guaranteed consistent with every other signature
 * emission). Captured from a scratch buffer.
 */
function c_param_type(param: ParameterLike, status: BuildStatus): string {
	const saved = status.code;
	status.code = "";
	build_parameter_node(param as never, status);
	const out = status.code;
	status.code = saved;
	return out;
}

interface ParameterLike {
	type: Type;
	name: string;
	is_variadic?: boolean;
	is_self_param?: boolean;
}

/** The C return type for a signature (a `func` return is a `void*` carrier). */
export function c_return_type(type: Type | undefined, status: BuildStatus): string {
	const name = type?.name;
	if (!name || name === "void") return "void";
	if (type?.is_pointer) return `${name}*`;
	if (type?.is_array) return `struct Array_${name}*`;
	if (type?.is_view) return "nomen_view";
	const elem = status.structs.find((s) => s.name === name && !s.is_simple_type);
	const is_class = !!status.structs.find((s) => s.name === name && s.is_class);
	const is_trait = !!status.traits.find((t) => t.name === name);
	if (is_class || is_trait) return `struct ${name}*`;
	if (elem) return `struct ${name}`;
	if (name === "func") return "void*";
	return c_type(name);
}

/**
 * Emit (once per target per TU) a thunk + static descriptor for a named
 * function used as a func VALUE, and return the descriptor expression.
 * The thunk has the closure ABI and forwards to the unchanged original.
 */
function materialize_named_function_descriptor(func: FunctionNode, status: BuildStatus): string {
	ensure_closure_runtime(status);
	const target = c_function_name(emission_label(func));
	const existing = status.closure_descriptors?.get(target);
	if (existing) return existing;

	const thunk = `_nomen_closure_thunk_${target}`;
	const descriptor = `_nomen_closure_desc_${target}`;

	// The thunk's parameters are exactly the target's (same lowering), with
	// the hidden env prepended; the body forwards them 1:1.
	const sig_params: string[] = [];
	const forwards: string[] = [];
	for (const p of func.params ?? []) {
		if (p.is_self_param) continue;
		const c_name = c_function_name(p.name);
		sig_params.push(c_param_type(p, status));
		forwards.push(c_name);
		if (p.is_variadic) {
			sig_params.push(`long _${c_name}_len`);
			forwards.push(`_${c_name}_len`);
		}
	}
	const sig = sig_params.join(", ");

	// Forward-declare the target (the thunk may be emitted before the
	// target's own prototype lands in the headers — compatible
	// redeclaration, the same trick the spawn trampolines use).
	const ret = c_return_type(func.return_type, status);
	status.headers += `${ret} ${target}(${sig});\n`;
	status.headers += `${ret} ${thunk}(void *_nomen_env, ${sig});\n`;
	status.headers += `static struct nomen_closure ${descriptor} = { (void *)${thunk}, NULL, 0, NULL };\n\n`;

	const call = `${target}(${forwards.join(", ")})`;
	const body = ret === "void" ? `\t${call};\n` : `\treturn ${call};\n`;
	status.closure_definitions =
		(status.closure_definitions ?? "") +
		`${ret} ${thunk}(void *_nomen_env, ${sig}) {\n` +
		`\t(void)_nomen_env;\n` +
		body +
		`}\n\n`;

	status.closure_descriptors!.set(target, `&${descriptor}`);
	return `&${descriptor}`;
}

/**
 * Emit (once per lambda per TU) the static descriptor for a capture-free
 * lambda, and return the descriptor expression. The lambda's definition
 * (with its hidden env parameter) has already been emitted by
 * build_lambda_closure_value via build_function_node — headers carry its
 * prototype.
 */
function materialize_lambda_descriptor(func: FunctionNode, status: BuildStatus): string {
	ensure_closure_runtime(status);
	const code = c_function_name(emission_label(func));
	const existing = status.closure_descriptors?.get(code);
	if (existing) return existing;
	const descriptor = `_nomen_closure_desc_${code}`;
	status.headers += `static struct nomen_closure ${descriptor} = { (void *)${code}, NULL, 0, NULL };\n`;
	status.closure_descriptors!.set(code, `&${descriptor}`);
	return `&${descriptor}`;
}

/**
 * Emit a capturing lambda in VALUE position (CLOSURE.md Phase 2): a heap
 * env struct holding one field per capture (copied from the enclosing scope at
 * materialization time), plus a heap descriptor (owned = 1) that the holder's
 * scope-exit free-if-owned arm reclaims.
 */
function capturing_closure_value(node: FunctionNode, status: BuildStatus): string {
	const env_name = emit_closure_env_type(node, status);
	const label = c_function_name(emission_label(node));
	let out = `({ struct ${env_name} *_e = (struct ${env_name} *)malloc(sizeof(struct ${env_name}));\n`;
	for (const cap of node.captures ?? []) {
		const field = c_function_name(cap.name);
		out += `_e->${field} = `;
		// The capture expression: the enclosing lambda's env field when the
		// name is itself captured by an outer closure (nested lambdas), else
		// the plain mangled C name. A name shadowed by a nearer local can't
		// reach here — the checker records a capture only when the reference
		// resolves to the outer value.
		const expr = status.closure_env?.get(cap.name) ?? c_function_name(cap.name);
		// An OWNED string capture is deep-copied into the env (the env's
		// destructor frees the copy); scalars copy by value.
		const elem = status.structs.find(
			(s) => s.name === cap.type.name && !s.is_simple_type && !s.is_class,
		);
		if (cap.type.name === "string" && !cap.type.is_view && !cap.type.is_array) {
			out += `nomen_str_dup(${expr})`;
		} else if (elem) {
			// A value struct is held by pointer: allocate + copy the value
			// (a MOVE capture transfers the bytes; a copy capture snapshots).
			// A struct PARAMETER donor is itself a pointer, so dereference it.
			const src = cap.by_address ? `(*${expr})` : expr;
			out += `({ struct ${cap.type.name} *_v = (struct ${cap.type.name} *)malloc(sizeof(struct ${cap.type.name})); *_v = ${src}; _v; })`;
		} else {
			// Class instance pointers and func descriptors transfer their
			// pointer directly.
			out += expr;
		}
		out += `;\n`;
		// A MOVE capture transfers ownership out of the donating local: mark
		// it so its scope-exit auto-free is skipped (the env destructor owns
		// it now), and drop any heap-string-field records for it (the env's
		// <T>_destroy reclaims the fields). Mirrors the `move`-arg path.
		if (cap.is_move) {
			if (!status.moved) status.moved = new Set();
			status.moved.add(cap.name);
			const prefix = `${cap.name}.`;
			for (const key of Array.from(status.heap_string_fields ?? [])) {
				if (key.startsWith(prefix)) status.heap_string_fields!.delete(key);
			}
		}
	}
	out += `struct nomen_closure *_c = (struct nomen_closure *)malloc(sizeof(struct nomen_closure));\n`;
	const destroy = emit_closure_env_free(node, status);
	out += `_c->code = (void *)${label};\n_c->env = (void *)_e;\n_c->owned = 1;\n`;
	out += `_c->destroy_env = ${destroy ? `(void (*)(void *))${destroy}` : "NULL"};\n`;
	out += `_c; })`;
	return out;
}

/**
 * Emit the C definition of a lambda in VALUE position and return the
 * descriptor expression for it (the value a func-typed slot receives). A
 * capturing lambda yields a heap descriptor owning its env; a capture-free one
 * yields a static descriptor.
 */
export function build_lambda_closure_value(
	node: FunctionNode,
	status: BuildStatus,
	already_built = false,
): string {
	// build_lambda_value buffers the lambda's definition first (C cannot nest
	// a function definition in an expression) and passes already_built so the
	// definition isn't emitted a second time here.
	if (!already_built) build_function_node(node, status);
	if (node.captures?.length) return capturing_closure_value(node, status);
	return materialize_lambda_descriptor(node, status);
}

/**
 * The value expression for a function reference used as a func VALUE:
 * a lambda's descriptor, or a thunk-backed descriptor for a named function.
 * `func_name` is the source-level name at the use site; the resolved
 * FunctionNode (when known) carries the signature.
 */
export function materialize_func_value(resolved: FunctionNode, status: BuildStatus): string {
	if ((resolved as unknown as { is_closure?: boolean }).is_closure) {
		return materialize_lambda_descriptor(resolved, status);
	}
	return materialize_named_function_descriptor(resolved, status);
}

let lambda_arg_temp_counter = 0;
let lambda_ret_temp_counter = 0;

/** A unique C temp name for one inline-lambda argument's captured descriptor. */
export function next_lambda_arg_temp(): string {
	return `_nomen_lambda_arg_${lambda_arg_temp_counter++}`;
}

/** A unique C temp name forwarding a wrapped call's value out of a wrapper. */
export function next_lambda_ret_temp(): string {
	return `_nomen_lambda_ret_${lambda_ret_temp_counter++}`;
}

/**
 * The uniform free-if-owned arm (CLOSURE.md) reclaiming a heap closure
 * descriptor held in the C local `tmp`: runs the env destructor when
 * present, then frees the env and the descriptor. Capture-free lambdas
 * point at static descriptors (owned = 0) and pass through untouched.
 */
export function closure_dispose_arm(tmp: string): string {
	return `if (${tmp}->owned) { if (${tmp}->destroy_env) ${tmp}->destroy_env(${tmp}->env); free(${tmp}->env); free(${tmp}); }`;
}
