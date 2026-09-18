import { struct_needs_destroy } from "../../build_common/destroy_analysis.ts";
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

type CaptureKind = "string" | "class" | "func" | "struct" | "trait" | "scalar";

/** Classify one capture for env layout / destruction purposes. */
function capture_kind(type: Type, status: BuildStatus): CaptureKind {
	if (type.name === "string" && !type.is_view && !type.is_array) return "string";
	if (type.name === "func") return "func";
	if (status.traits.find((t) => t.name === type.name)) return "trait";
	const elem = status.structs.find((s) => s.name === type.name);
	if (elem?.is_class) return "class";
	if (elem && !elem.is_simple_type) return "struct";
	return "scalar";
}

/**
 * The C declaration type for one capture's env field. Value structs (owning or
 * not) and classes are held by POINTER — a struct's full C definition lands in
 * the CODE (after the headers this typedef is emitted into), so an inline field
 * would be an incomplete type; a class value already IS a pointer.
 */
export function c_env_field_type(type: Type, status: BuildStatus): string {
	switch (capture_kind(type, status)) {
		case "string":
			return "nomen_string";
		case "struct":
			return `struct ${type.name} *`;
		case "class":
			return `struct ${type.name} *`;
		case "trait":
			// A trait value is a `void *` to the concrete instance (vtable at
			// its head) on the C backend.
			return "void *";
		case "func":
			return "struct nomen_closure *";
		default:
			return c_type(type.name);
	}
}

/** Whether a lambda's env owns heap values needing a destructor. */
export function lambda_has_owned_captures(func: FunctionNode, status: BuildStatus): boolean {
	return (func.captures ?? []).some((c) => capture_kind(c.type, status) !== "scalar");
}

/**
 * Emit (once per lambda per TU) the env destructor for a capturing lambda
 * whose env owns heap values. Phase 2b: captured strings are strdup'd into the
 * env. Phase 2c part 2: owning value structs, classes and func descriptors are
 * MOVED in, so the destructor destroys/frees them. A capture-free or
 * scalar-only lambda needs none (the descriptor's `destroy_env` is NULL).
 * Returns the destructor's C name, or undefined.
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
		const kind = capture_kind(cap.type, status);
		if (kind === "string") {
			body += `\tif (_e->${field}.ptr) free(_e->${field}.ptr);\n`;
			continue;
		}
		if (kind === "func") {
			// A captured func value may be a static (capture-free) descriptor
			// (owned = 0) or a heap capturing closure (owned = 1). Same
			// free-if-owned arm as a func-typed local.
			body += `\tif (_e->${field} && _e->${field}->owned) { if (_e->${field}->destroy_env) _e->${field}->destroy_env(_e->${field}->env); free(_e->${field}->env); free(_e->${field}); }\n`;
			continue;
		}
		if (kind === "class") {
			body += `\tif (_e->${field}) { ${cap.type.name}_destroy(_e->${field}); free(_e->${field}); }\n`;
			continue;
		}
		if (kind === "trait") {
			// Dispatch through the trait's vtable destroy shim (the concrete
			// instance type may vary), then free the instance.
			body += `\tif (_e->${field}) { ${cap.type.name}_destroy(_e->${field}); free(_e->${field}); }\n`;
			continue;
		}
		if (kind === "struct") {
			const elem = status.structs.find((s) => s.name === cap.type.name && !s.is_simple_type);
			// A MOVE-captured owning struct owns its heap fields: run the
			// struct's destroy before freeing the env copy. A copied
			// (non-owning) struct owns only the malloc'd copy.
			if (cap.is_move && elem && struct_needs_destroy(elem, status)) {
				body += `\tif (_e->${field}) { ${cap.type.name}_destroy(_e->${field}); free(_e->${field}); }\n`;
			} else {
				body += `\tif (_e->${field}) free(_e->${field});\n`;
			}
			continue;
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
