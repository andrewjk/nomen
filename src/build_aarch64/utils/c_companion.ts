import type BuildStatus from "../../build_c/BuildStatus.ts";
import c_type from "../../build_c/utils/c_type.ts";
import { is_overloaded, mangled_label } from "../../check/utils/function_overload.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import TraitNode from "../../nodes/TraitNode.ts";
import { get_struct_size } from "./struct_layout.ts";

export interface CompanionFunction {
	func: FunctionNode;
	struct_name?: string;
	raw_code: string;
}

/**
 * Generate the complete C companion file: includes, struct typedefs, and
 * function definitions for every collected `aarch64_use_c` function.
 */
export function generate_companion(functions: CompanionFunction[], status: BuildStatus): string {
	let out = "";

	// --- Includes ---
	if (status.platform === "macos" || status.platform === "ios") {
		out += `#import <Foundation/Foundation.h>\n`;
		out += `#include <objc/runtime.h>\n`;
		out += `#include <objc/message.h>\n`;
		if (status.platform === "macos") {
			out += `#import <Cocoa/Cocoa.h>\n`;
		} else {
			out += `#import <UIKit/UIKit.h>\n`;
		}
	}
	out += `#include <stdint.h>\n`;
	out += `#include <stdlib.h>\n`;
	// Standard libc headers commonly needed by companion function bodies.
	// These are included at file scope (not inside function bodies) because
	// headers defining types (e.g. regex.h's regex_t) are guarded and only
	// expand once, so per-function includes would leave later functions
	// without the type definitions.
	out += `#include <stdio.h>\n`;
	out += `#include <string.h>\n`;
	out += `#include <regex.h>\n`;
	if (status.file_scope_c?.includes("pthread")) {
		out += `#include <pthread.h>\n`;
	}
	out += "\n";

	// Forward-declare the audit wrapper functions when audit mode is on.
	// The pool infrastructure uses nomen_malloc_wrap/nomen_free_wrap (after
	// wrapping in build.ts), but they're defined in a separate audit_runtime.o.
	if (status.audit) {
		out += `void *nomen_malloc_wrap(unsigned long);\n`;
		out += `void *nomen_calloc_wrap(unsigned long, unsigned long);\n`;
		out += `void *nomen_realloc_wrap(void *, unsigned long);\n`;
		out += `void nomen_free_wrap(void *);\n`;
		out += `void *nomen_strdup_wrap(const char *);\n`;
		out += `void nomen_audit_check(void);\n`;
		out += "\n";
	}

	// --- Struct definitions ---
	// Emit every non-simple struct so the function bodies can reference them.
	// Definitions are ordered so that a struct's value-field dependencies are
	// defined before it (e.g. Buffer_JsonNode before JsonTree, which contains
	// it by value). Pointer fields (generics → void *) need no ordering.
	const structs_to_emit = order_structs_by_dependency(
		status.structs.filter((s) => !s.is_simple_type && !s.is_generic),
	);
	const emitted = new Set<string>();
	for (const struct of structs_to_emit) {
		if (emitted.has(struct.name)) continue;
		emitted.add(struct.name);
		out += generate_struct_definition(struct, status);
	}
	out += "\n";

	// --- File-scope C code (pool infrastructure, #scope: file blocks) ---
	if (status.file_scope_c) {
		out += status.file_scope_c;
		out += "\n";
	}

	// --- Function definitions ---
	for (const entry of functions) {
		out += generate_c_function(entry.func, entry.struct_name, entry.raw_code, status);
	}

	return out;
}

function field_c_type(typeName: string, status: BuildStatus): string {
	// Generic structs (e.g. Buffer<int>) are stored as 8-byte pointers in C.
	const struct = status.structs.find((s) => s.name === typeName);
	if (struct?.is_generic) return "void *";
	return c_type(typeName);
}

/**
 * Order structs so that value-field dependencies are defined first.
 * A struct A that has a value field of type B (non-pointer, non-generic)
 * requires B's full definition to precede A's. Pointer fields (generics
 * rendered as void *) and primitive fields impose no ordering.
 */
function order_structs_by_dependency(structs: StructNode[]): StructNode[] {
	const by_name = new Map(structs.map((s) => [s.name, s]));
	const deps = new Map<string, Set<string>>();
	for (const s of structs) {
		const s_deps = new Set<string>();
		for (const field of s.fields) {
			const dep_struct = by_name.get(field.type.name);
			if (dep_struct && !dep_struct.is_generic && !dep_struct.is_simple_type) {
				s_deps.add(field.type.name);
			}
		}
		deps.set(s.name, s_deps);
	}
	const result: StructNode[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();
	function visit(name: string) {
		if (visited.has(name) || visiting.has(name)) return;
		visiting.add(name);
		for (const dep of deps.get(name) ?? []) visit(dep);
		visiting.delete(name);
		visited.add(name);
		const s = by_name.get(name);
		if (s) result.push(s);
	}
	for (const s of structs) visit(s.name);
	return result;
}

function generate_struct_definition(struct: StructNode, status: BuildStatus): string {
	let out = `typedef struct ${struct.name}\n{\n`;
	out += `void *_vt;\n`;
	for (const field of struct.fields) {
		out += `${field_c_type(field.type.name, status)} ${field.name};\n`;
	}
	for (const traitName of struct.traits) {
		const trait = status.traits.find((t) => t.name === traitName) as TraitNode | undefined;
		if (!trait) continue;
		for (const field of trait.fields.filter(
			(f) => !struct.fields.find((nf) => nf.name === f.name),
		)) {
			out += `${field_c_type(field.type.name, status)} ${field.name};\n`;
		}
	}
	out += `} ${struct.name};\n`;
	return out;
}

function generate_c_function(
	func: FunctionNode,
	struct_name: string | undefined,
	raw_code: string,
	status: BuildStatus,
): string {
	// --- Determine function label ---
	let func_label: string;
	if (struct_name) {
		const struct = status.structs.find((s) => s.name === struct_name);
		if (struct && is_overloaded(struct, func.name)) {
			func_label = mangled_label(func, struct_name);
		} else {
			func_label = `${struct_name}_${func.name.replace(/#/g, "")}`;
		}
	} else {
		func_label = func.name === "main" ? "_nomen_main" : func.name;
	}

	// A class `#init` follows the aarch64 constructor convention: the caller
	// mallocs the instance and passes it as `self` in x0; the init function is
	// void and mutates `self` in place (the body writes `self->field = ...`).
	// So it must NOT be treated as a struct-returning function (no `_c` suffix,
	// no thunk) — it emits under the bare `X_init` name that the asm `bl` targets.
	const is_class_init =
		func.name === "#init" &&
		!!(struct_name && status.structs.find((s) => s.name === struct_name)?.is_class);

	// --- Build return type prefix ---
	const return_type = is_class_init ? "void" : func.return_type?.name || "void";
	const return_struct = is_class_init
		? undefined
		: status.structs.find((s) => s.name === return_type && !s.is_simple_type);
	let return_prefix = "";
	if (return_struct) {
		return_prefix += `struct `;
	}
	return_prefix += c_type(return_type);
	return_prefix += ` `;

	// Struct-returning functions get a `_c` suffix because the aarch64
	// assembly emits a thunk (under the bare name) that bridges the x8
	// struct-return convention to the standard ARM64 register-return ABI.
	const return_struct_size = return_struct ? get_struct_size(return_type, status) : 0;
	const needs_thunk = return_struct && return_struct_size <= 16;
	const symbol_label = needs_thunk ? `${func_label}_c` : func_label;

	// --- Build parameter list ---
	const params = func.params;
	let param_list = "";
	for (let i = 0; i < params.length; i++) {
		if (i > 0) param_list += ", ";
		param_list += generate_c_param(params[i], status);
	}
	if (params.length === 0) {
		param_list += `void`;
	}

	let out = `// ${func_label}\n`;

	// On macOS, C functions get a leading `_` in the symbol table, but the
	// aarch64 assembly references them without. Emit an asm label to force
	// the unmangled symbol name so the linker can resolve `bl FuncName`.
	out += `${return_prefix}${symbol_label}(${param_list}) __asm__("${symbol_label}");\n`;

	// --- Function definition ---
	out += `${return_prefix}${symbol_label}(${param_list})\n{\n`;

	// --- _self copy for struct methods (non-ref, non-destroy, non-init) ---
	const self_param = params[0];
	if (
		struct_name &&
		self_param?.is_self_param &&
		!self_param?.is_ref &&
		func.name !== "#destroy" &&
		func.name !== "#init"
	) {
		const struct = status.structs.find((s) => s.name === struct_name);
		if (struct && !struct.is_simple_type) {
			out += `struct ${struct_name} _self = *self;\n`;
		}
	}

	// --- Raw body ---
	out += raw_code;
	out += `\n}\n\n`;

	return out;
}

function generate_c_param(param: ParameterNode, status: BuildStatus): string {
	const struct_type = status.structs.find((s) => s.name === param.type.name);
	const trait_type = status.traits.find((t) => t.name === param.type.name);
	const is_struct =
		(param.is_self_param || struct_type || trait_type) && !struct_type?.is_simple_type;

	let out = "";
	if (param.is_variadic) {
		out += `long _${param.name}_len, `;
	}
	if (is_struct) {
		out += `struct `;
	}
	out += c_type(param.type.name);
	if (is_struct || param.declaration === "var" || param.type.is_ref || param.type.is_array) {
		out += ` *`;
	} else {
		out += ` `;
	}
	out += param.name;
	return out;
}
