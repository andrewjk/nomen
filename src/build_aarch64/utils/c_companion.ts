import type BuildStatus from "../../build_c/BuildStatus.ts";
import c_type from "../../build_c/utils/c_type.ts";
import { is_overloaded, mangled_label } from "../../check/utils/function_overload.ts";
import EnumNode from "../../nodes/EnumNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import TraitNode from "../../nodes/TraitNode.ts";
import { FIBER_HEADER_C, POOL_HEADER_C } from "../build_spawn_node.ts";
import { get_enum_sret_size, get_struct_size } from "./struct_layout.ts";

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
	// The UI frameworks are only needed by `aarch64_use_c` bodies. Importing
	// them unconditionally pulls MacTypes.h (`Point`, `Rect`, …) into every
	// companion, colliding with the generated struct typedefs when a program
	// has no UI bodies at all (e.g. a companion that only carries the
	// concurrency runtime).
	if (functions.length > 0 && (status.platform === "macos" || status.platform === "ios")) {
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

	// --- Concurrency runtime ---
	// The precompiled system object holds Fiber's static wrappers
	// (Fiber.yield / is_fiber / set_cooperative), which branch into the
	// runtime; every companion must therefore define the pool + fiber
	// symbols, whether or not this program uses concurrency itself.
	// Deduped against any runtime text already queued in file_scope_c.
	if (!status.pool_runtime_emitted) {
		out += POOL_HEADER_C;
		status.pool_runtime_emitted = true;
	}
	if (!status.fiber_runtime_emitted) {
		out += FIBER_HEADER_C;
		status.fiber_runtime_emitted = true;
	}

	// --- Enum + struct definitions ---
	// Emit both kinds in dependency order: a struct may contain an enum by
	// value (needs the enum first) and an enum payload may contain a struct by
	// value (needs the struct first), so a fixed two-pass order cannot work.
	// Independent types keep enums-before-structs. Enum case names keep the
	// `Enum_case` form (only referenced by index from assembly) and type names
	// are `nm_`-prefixed (see `nm`) to dodge system-header collisions.
	const enum_nodes = status.enums.filter((e) => !e.is_generic);
	const struct_nodes = status.structs.filter((s) => !s.is_simple_type && !s.is_generic);
	const node_kind = new Map<string, "enum" | "struct" | "bitset">();
	for (const e of enum_nodes) node_kind.set(e.name, "enum");
	for (const st of struct_nodes) node_kind.set(st.name, "struct");
	for (const b of status.bitsets) node_kind.set(b.name, "bitset");
	const deps = new Map<string, Set<string>>();
	for (const e of enum_nodes) {
		const d = new Set<string>();
		for (const c of e.cases) {
			for (const p of c.params) {
				if (node_kind.has(p.type.name) && p.type.name !== e.name) d.add(p.type.name);
			}
		}
		deps.set(e.name, d);
	}
	for (const st of struct_nodes) {
		const d = new Set<string>();
		for (const f of st.fields) {
			if (f.type.is_view) continue;
			if (node_kind.has(f.type.name) && f.type.name !== st.name) d.add(f.type.name);
		}
		deps.set(st.name, d);
	}
	const emitted = new Set<string>();
	const visiting = new Set<string>();
	const node_list = [...enum_nodes, ...struct_nodes, ...status.bitsets];
	const by_name = new Map<string, (typeof node_list)[number]>(node_list.map((n) => [n.name, n]));
	const visit = (name: string) => {
		if (emitted.has(name) || visiting.has(name)) return;
		visiting.add(name);
		for (const dep of deps.get(name) ?? []) visit(dep);
		visiting.delete(name);
		emitted.add(name);
		const node = by_name.get(name);
		if (!node) return;
		if (node_kind.get(name) === "enum") {
			out += generate_enum_definition(node as EnumNode, status);
		} else if (node_kind.get(name) === "bitset") {
			out += `typedef unsigned long ${nm(name)};\n`;
		} else {
			out += generate_struct_definition(node as StructNode, status);
		}
	};
	for (const n of node_list) visit(n.name);
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
/**
 * The C type for a value stored BY VALUE in an enum payload: classes and
 * traits are heap/shared references (pointers, and never have a companion
 * typedef), everything else follows `companion_type`.
 */
function payload_type(typeName: string, status: BuildStatus): string {
	const struct = status.structs.find((s) => s.name === typeName);
	if (struct?.is_class) return `struct ${typeName} *`;
	if (status.traits.find((t) => t.name === typeName)) return `struct ${typeName} *`;
	return companion_type(typeName, status);
}

function companion_type(typeName: string, status: BuildStatus): string {
	const struct = status.structs.find((s) => s.name === typeName);
	if (struct?.is_generic) return "void *";
	if (struct && !struct.is_simple_type) return nm(typeName);
	if (!struct && status.enums.find((e) => e.name === typeName)) return nm(typeName);
	if (status.bitsets.find((b) => b.name === typeName)) return nm(typeName);
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
function generate_enum_definition(node: EnumNode, status: BuildStatus): string {
	let out = "";
	if (node.has_associated_data) {
		out += `typedef enum { ${node.cases.map((c) => `${node.name}_${c.name}`).join(", ")} } ${nm(node.name)}_tag;\n`;
		out += `struct ${node.name};\n`;
		out += `typedef struct ${node.name}\n{\n`;
		out += `${nm(node.name)}_tag tag;\n`;
		out += `union {\n`;
		for (const c of node.cases) {
			out += `struct { ${c.params.map((p) => `${payload_type(p.type.name, status)} ${p.name}`).join("; ")}${c.params.length ? ";" : ""} } _${c.name};\n`;
		}
		out += `} _data;\n`;
		out += `} ${nm(node.name)};\n`;
	} else {
		out += `typedef enum { ${node.cases.map((c) => `${node.name}_${c.name}`).join(", ")} } ${nm(node.name)};\n`;
	}
	return out;
}

function generate_struct_definition(struct: StructNode, status: BuildStatus): string {
	let out = `typedef struct ${struct.name}\n{\n`;
	out += `void *_vt;\n`;
	for (const field of struct.fields) {
		// A `view T` field is the universal (ptr, len) slice value — every
		// view lowers to nomen_view regardless of its element type.
		out += `${field.type.is_view ? "nomen_view" : payload_type(field.type.name, status)} ${field.name};\n`;
	}
	for (const traitName of struct.traits) {
		const trait = status.traits.find((t) => t.name === traitName) as TraitNode | undefined;
		if (!trait) continue;
		for (const field of trait.fields.filter(
			(f) => !struct.fields.find((nf) => nf.name === f.name),
		)) {
			out += `${field.type.is_view ? "nomen_view" : payload_type(field.type.name, status)} ${field.name};\n`;
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

	// Companion bodies see the same fat ABI as everywhere else (see
	// docs/MEMORY.md): a `string` return is the `nomen_string` value the
	// body builds itself — `(nomen_string){ ptr, len }` — and string params
	// pass their `.ptr` half at C/ObjC boundaries. AAPCS returns the
	// 16-byte pair in (x0, x1), exactly what the assembly caller expects.

	// Struct-returning functions get a `_c` suffix because the aarch64
	// assembly emits a thunk (under the bare name) that bridges the x8
	// struct-return convention to the standard ARM64 register-return ABI.
	// Enum-with-data returns share the x8 sret convention on the asm side,
	// so they need the same bridging when the C ABI would return the value
	// in registers (≤ 16 bytes; larger C returns already ride the hidden
	// x8 sret pointer, matching the asm convention naturally).
	const return_enum_size = return_struct ? undefined : get_enum_sret_size(return_type, status);
	const return_struct_size = return_struct ? get_struct_size(return_type, status) : 0;
	const needs_thunk =
		(return_struct && return_struct_size <= 16) ||
		(return_enum_size !== undefined && return_enum_size <= 16);
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
			out += `${nm(struct_name)} _self = *self;\n`;
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
