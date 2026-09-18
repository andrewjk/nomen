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
	const elem = status.structs.find((s) => s.name === name && !s.is_simple_type);
	if (elem && !elem.is_class) return `struct ${name}`;
	return c_type(name);
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
