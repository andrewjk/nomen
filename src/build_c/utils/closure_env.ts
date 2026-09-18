import emission_label from "../../build_common/emission_label.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import type Type from "../../nodes/Type.ts";
import type BuildStatus from "../BuildStatus.ts";
import c_function_name from "./c_function_name.ts";
import c_type from "./c_type.ts";

/**
 * Closure capture environments (docs/CLOSURE_PLAN.md Phase 2). A capturing
 * lambda gets a compiler-generated env struct with one field per capture; the
 * value site heap-allocates it and stores it in the closure descriptor. Kept
 * in this leaf module (it imports neither build_node nor build_function_node)
 * so both the value emitter and the function prologue can use it without an
 * import cycle.
 */

/**
 * The C declaration type for one capture's env field. Only scalars and
 * non-owning value structs are capturable (Phase 2a), so the field is the
 * plain C value type (structs by value, never a pointer).
 */
export function c_env_field_type(type: Type, status: BuildStatus): string {
	const name = type.name;
	if (name === "string" && !type.is_view && !type.is_array) return "nomen_string";
	// A value struct is held by POINTER: its full C definition lands in the
	// CODE (after the headers this typedef is emitted into), so an inline
	// field would be an incomplete type. The env owns the pointer (the
	// destructor frees it) and the capture map reads it as `(*field)`.
	const elem = status.structs.find((s) => s.name === name && !s.is_simple_type);
	if (elem && !elem.is_class) return `struct ${name} *`;
	return c_type(name);
}

/** Whether a lambda's env owns heap values needing a destructor. */
export function lambda_has_owned_captures(func: FunctionNode, status?: BuildStatus): boolean {
	return (func.captures ?? []).some(
		(c) =>
			c.type.name === "string" ||
			!!status?.structs.find((s) => s.name === c.type.name && !s.is_simple_type && !s.is_class),
	);
}

/**
 * Emit (once per lambda per TU) the env destructor for a capturing lambda
 * whose env owns heap values (Phase 2b: captured strings are strdup'd into the
 * env). A capture-free or scalar-only lambda needs none (the descriptor's
 * `destroy_env` is NULL). Returns the destructor's C name, or undefined.
 */
export function emit_closure_env_free(func: FunctionNode, status: BuildStatus): string | undefined {
	if (!lambda_has_owned_captures(func, status)) return undefined;
	const env_name = `_nomen_env_${c_function_name(emission_label(func))}`;
	const fn_name = `_nomen_env_free_${c_function_name(emission_label(func))}`;
	const guard = `_nomen_env_free_emitted_${env_name}`;
	if (!status.closure_env_types) status.closure_env_types = new Set();
	if (status.closure_env_types.has(guard)) return fn_name;
	status.closure_env_types.add(guard);
	let body = "";
	for (const cap of func.captures ?? []) {
		const field = c_function_name(cap.name);
		if (cap.type.name === "string") {
			body += `\tif (_e->${field}.ptr) free(_e->${field}.ptr);\n`;
			continue;
		}
		const elem = status.structs.find((s) => s.name === cap.type.name && !s.is_simple_type);
		if (elem && !elem.is_class) {
			body += `\tif (_e->${field}) free(_e->${field});\n`;
		}
	}
	status.headers += `static void ${fn_name}(void *);\n`;
	status.closure_definitions =
		(status.closure_definitions ?? "") +
		`static void ${fn_name}(void *_p) {\n` +
		`\tstruct ${env_name} *_e = (struct ${env_name} *)_p;\n` +
		body +
		`}\n\n`;
	return fn_name;
}

/**
 * Emit a capturing lambda's env struct typedef into the headers (once per TU)
 * and return its C struct name. One field per capture, named after it.
 */
export function emit_closure_env_type(func: FunctionNode, status: BuildStatus): string {
	const env_name = `_nomen_env_${c_function_name(emission_label(func))}`;
	if (!status.closure_env_types) status.closure_env_types = new Set();
	if (!status.closure_env_types.has(env_name)) {
		status.closure_env_types.add(env_name);
		let decls = "";
		for (const cap of func.captures ?? []) {
			decls += `\t${c_env_field_type(cap.type, status)} ${c_function_name(cap.name)};\n`;
		}
		status.headers += `struct ${env_name} {\n${decls}};\n`;
	}
	return env_name;
}
