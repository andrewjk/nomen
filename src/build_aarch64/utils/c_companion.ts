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
	out += `#include <regex.h>\n\n`;

	// --- Struct typedefs ---
	// Emit every non-simple struct so the function bodies can reference them.
	const emitted = new Set<string>();
	for (const struct of status.structs) {
		if (struct.is_simple_type || struct.is_generic) continue;
		if (emitted.has(struct.name)) continue;
		emitted.add(struct.name);
		out += generate_struct_typedef(struct, status);
	}
	out += "\n";

	// --- Function definitions ---
	for (const entry of functions) {
		out += generate_c_function(entry.func, entry.struct_name, entry.raw_code, status);
	}

	return out;
}

function generate_struct_typedef(struct: StructNode, status: BuildStatus): string {
	let out = `typedef struct ${struct.name}\n{\n`;
	out += `void *_vt;\n`;
	for (const field of struct.fields) {
		out += `${c_type(field.type.name)} ${field.name};\n`;
	}
	for (const traitName of struct.traits) {
		const trait = status.traits.find((t) => t.name === traitName) as TraitNode | undefined;
		if (!trait) continue;
		for (const field of trait.fields.filter(
			(f) => !struct.fields.find((nf) => nf.name === f.name),
		)) {
			out += `${c_type(field.type.name)} ${field.name};\n`;
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
		func_label = func.name === "main" ? "_echo_main" : func.name;
	}

	// --- Build return type prefix ---
	const return_type = func.return_type?.name || "void";
	const return_struct = status.structs.find((s) => s.name === return_type && !s.is_simple_type);
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

	// --- _self copy for struct methods (non-ref, non-destroy) ---
	const self_param = params[0];
	if (struct_name && self_param?.is_self_param && !self_param?.is_ref && func.name !== "#destroy") {
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
