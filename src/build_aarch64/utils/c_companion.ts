import type BuildStatus from "../../build_c/BuildStatus.ts";
import c_type from "../../build_c/utils/c_type.ts";
import { is_overloaded, mangled_label } from "../../check/utils/function_overload.ts";
import EnumNode from "../../nodes/EnumNode.ts";
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
	// The fat-string/view value types shared with the asm side (a 16-byte
	// composite rides a register pair per AAPCS64, matching the compiler's
	// pair ABI).
	out += `typedef struct { void* ptr; long len; } nomen_view;\n`;
	out += `typedef struct { char* ptr; long len; } nomen_string;\n`;
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

	// --- Enum definitions ---
	// Emit every enum before the structs: a struct may have a field of enum
	// type (e.g. LayoutParams.width: LayoutLength), and the typedef must be in
	// scope. Enum case names keep the `Enum_case` form (they're only referenced
	// by index from assembly, never by name in companion bodies). Type names are
	// `nm_`-prefixed (see `nm`) to avoid collisions with system typedefs pulled
	// in by the framework imports above (e.g. macOS MacTypes.h defines `Size`).
	const emitted_enums = new Set<string>();
	for (const e of status.enums) {
		if (emitted_enums.has(e.name)) continue;
		// Generic enums are templates with no concrete layout; only their
		// monomorphized forms (also in status.enums) are real types.
		if (e.is_generic) continue;
		emitted_enums.add(e.name);
		out += generate_enum_definition(e, status);
	}
	out += "\n";

	// --- Struct definitions ---
	// Emit every non-simple struct so the function bodies can reference them.
	// Definitions are ordered so that a struct's value-field dependencies are
	// defined before it (e.g. Buffer_JsonNode before JsonTree, which contains
	// it by value). Pointer fields (generics → void *) need no ordering. Type
	// names are `nm_`-prefixed (see `nm`) to dodge system-header collisions.
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

/**
 * Prefix a Nomen type's C TYPEDEF name with `nm_`. The companion file `#import`s
 * the platform frameworks (Foundation/Cocoa/UIKit), which drag in a large set of
 * system typedefs (e.g. macOS `MacTypes.h` defines `typedef long Size`). If we
 * emitted Nomen's own `typedef struct Size {...} Size;` the typedef name would
 * collide; mangling only the typedef (`typedef struct Size {...} nm_Size;`)
 * sidesteps it while leaving the struct TAG (`Size`) untouched.
 *
 * Keeping the original tag matters: generated C (spawn/trampoline infra in
 * build_spawn_node / build_nursery_spawn) and `#arch: aarch64_use_c` raw bodies
 * reference Nomen types as `struct Foo` (the tag), so an unchanged tag means
 * none of that code needs to know about mangling. Codegen-generated references
 * here (fields, params, returns) use the mangled typedef instead.
 *
 * `nm_` (no leading underscore: the C standard reserves `_`+lowercase
 * identifiers at file scope). This is purely cosmetic — the aarch64 assembly
 * never references type names (only function labels, bridged via `__asm__`).
 */
function nm(name: string): string {
	return "nm_" + name;
}

/**
 * The C type for a field/param/return of the given Nomen type, applying `nm_`
 * to user-defined struct/enum types and falling back to `c_type` for primitives.
 * Generic structs lower to opaque 8-byte pointers (their element type lives in
 * the Nomen `Type`, not in the C layout).
 */
function companion_type(typeName: string, status: BuildStatus): string {
	const struct = status.structs.find((s) => s.name === typeName);
	if (struct?.is_generic) return "void *";
	if (struct && !struct.is_simple_type) return nm(typeName);
	if (!struct && status.enums.find((e) => e.name === typeName)) return nm(typeName);
	return c_type(typeName);
}

/**
 * Emit an enum's C type definition. Mirrors the C backend's `build_enum_node`
 * (typedef for simple enums; tag + tagged-union struct for enums with associated
 * data) but with `nm_`-prefixed TYPEDEF names and no constructor functions (those
 * are emitted as assembly in the aarch64 path; the companion only needs types so
 * struct fields / function signatures can reference them). The struct tag keeps
 * the original Nomen name (see `nm`).
 */
function generate_enum_definition(node: EnumNode, _status: BuildStatus): string {
	let out = "";
	if (node.has_associated_data) {
		out += `typedef enum { ${node.cases.map((c) => `${node.name}_${c.name}`).join(", ")} } ${nm(node.name)}_tag;\n`;
		out += `struct ${node.name};\n`;
		out += `typedef struct ${node.name}\n{\n`;
		out += `${nm(node.name)}_tag tag;\n`;
		out += `union {\n`;
		for (const c of node.cases) {
			out += `struct { ${c.params.map((p) => `${c_type(p.type.name)} ${p.name}`).join("; ")}${c.params.length ? ";" : ""} } _${c.name};\n`;
		}
		out += `} _data;\n`;
		out += `} ${nm(node.name)};\n`;
	} else {
		out += `typedef enum { ${node.cases.map((c) => `${node.name}_${c.name}`).join(", ")} } ${nm(node.name)};\n`;
	}
	return out;
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
			// A `view T` field lowers to nomen_view (no struct dependency).
			if (field.type.is_view) continue;
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
		// A `view T` field is the universal (ptr, len) slice value — every
		// view lowers to nomen_view regardless of its element type.
		out += `${field.type.is_view ? "nomen_view" : companion_type(field.type.name, status)} ${field.name};\n`;
	}
	for (const traitName of struct.traits) {
		const trait = status.traits.find((t) => t.name === traitName) as TraitNode | undefined;
		if (!trait) continue;
		for (const field of trait.fields.filter(
			(f) => !struct.fields.find((nf) => nf.name === f.name),
		)) {
			out += `${field.type.is_view ? "nomen_view" : companion_type(field.type.name, status)} ${field.name};\n`;
		}
	}
	out += `} ${nm(struct.name)};\n`;
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
	// Use the mangled typedef (`nm_Foo`) for struct/enum returns; primitives pass
	// through `companion_type` unchanged. The typedef is always in scope here
	// (every struct/enum is defined above the function bodies).
	let return_prefix = return_struct ? nm(return_type) : companion_type(return_type, status);
	return_prefix += ` `;

	// A fat-string RETURN (`out string`) can't come straight out of a raw
	// body authored against the thin (char*) ABI. Emit the body under a
	// `_raw_` label with a thin `char*` result and bridge it: the wrapper
	// builds the {ptr, strlen} pair — which AAPCS returns in x0/x1, exactly
	// the pair the assembly caller expects. String PARAMS likewise pass
	// their ptr half into the thin body.
	const returns_fat_string =
		!is_class_init &&
		return_type === "string" &&
		!func.return_type?.is_view &&
		!func.return_type?.is_array;

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
		param_list += generate_c_param(params[i], status, returns_fat_string);
	}
	if (params.length === 0) {
		param_list += `void`;
	}

	let out = `// ${func_label}\n`;

	if (returns_fat_string) {
		const raw_symbol = `_raw_${symbol_label}`;
		let thin_params = "";
		for (let i = 0; i < params.length; i++) {
			if (i > 0) thin_params += ", ";
			thin_params += generate_c_param(params[i], status, true);
		}
		if (params.length === 0) thin_params = "void";
		// Thin body: authored against the old char* ABI.
		out += `char* ${raw_symbol}(${thin_params}) __asm__("${raw_symbol}");\n`;
		out += `char* ${raw_symbol}(${thin_params})\n{\n`;
		out += raw_code;
		out += `\n}\n\n`;
		// Fat wrapper: builds the {ptr, len} pair the asm caller consumes
		// from the (x0, x1) register pair.
		out += `${return_prefix}${symbol_label}(${param_list}) __asm__("${symbol_label}");\n`;
		out += `${return_prefix}${symbol_label}(${param_list})\n{\n`;
		const call_args = params
			.map((p) => {
				const pname = p.name;
				return p.type.name === "string" && !p.type.is_view && !p.type.is_array
					? p.is_ref
						? `${pname}->ptr`
						: `${pname}.ptr`
					: pname;
			})
			.join(", ");
		out += `char* _r = ${raw_symbol}(${call_args});\n`;
		out += `return (nomen_string){ _r, (long)strlen(_r) };\n`;
		out += `\n}\n\n`;
		return out;
	}

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
			out += `${nm(struct_name)} _self = *self;\n`;
		}
	}

	// --- Raw body ---
	out += raw_code;
	out += `\n}\n\n`;

	return out;
}

function generate_c_param(param: ParameterNode, status: BuildStatus, thin_string = false): string {
	const struct_type = status.structs.find((s) => s.name === param.type.name);
	const trait_type = status.traits.find((t) => t.name === param.type.name);
	const is_struct =
		(param.is_self_param || struct_type || trait_type) && !struct_type?.is_simple_type;

	let out = "";
	if (param.is_variadic) {
		out += `long _${param.name}_len, `;
	}
	if (thin_string && param.type.name === "string" && !param.type.is_view && !param.type.is_array) {
		// Thin raw body: a by-value string param is the bare char* ptr half.
		if (param.is_ref || param.type.is_ref) return `char** ${param.name}`;
		return `char* ${param.name}`;
	}
	// Struct/enum params use the mangled typedef (`nm_Foo`); the typedef is in
	// scope above the function bodies. Pointer-ness is decided separately below.
	out += companion_type(param.type.name, status);
	if (is_struct || param.declaration === "var" || param.type.is_ref || param.type.is_array) {
		out += ` *`;
	} else {
		out += ` `;
	}
	out += param.name;
	return out;
}
