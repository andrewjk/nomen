import { reset_access_temp_counter } from "./build_aarch64/build_access_node.ts";
import { reset_label_counter as reset_for_label_counter } from "./build_aarch64/build_for_loop_node.ts";
import { reset_temp_counter as reset_func_call_temp_counter } from "./build_aarch64/build_function_call_node.ts";
import { reset_label_counter as reset_func_label_counter } from "./build_aarch64/build_function_node.ts";
import { reset_label_counter as reset_if_label_counter } from "./build_aarch64/build_if_else_node.ts";
import { reset_inline_counter } from "./build_aarch64/build_inline_method.ts";
import build_aarch64_node from "./build_aarch64/build_node.ts";
import { reset_string_counter as reset_op_string_counter } from "./build_aarch64/build_operation_node.ts";
import { reset_string_counter as reset_value_string_counter } from "./build_aarch64/build_value_node.ts";
import { reset_label_counter as reset_while_label_counter } from "./build_aarch64/build_while_loop_node.ts";
import { emit_malloc } from "./build_aarch64/utils/audit.ts";
import { generate_companion } from "./build_aarch64/utils/c_companion.ts";
import { scan_heap_returning_functions } from "./build_aarch64/utils/scan_heap_returns.ts";
import { scan_inline_candidates } from "./build_aarch64/utils/scan_inline_candidates.ts";
import build_c_node from "./build_c/build_node.ts";
import type BuildStatus from "./build_c/BuildStatus.ts";
import BaseNode from "./nodes/BaseNode.ts";
import type BuildResult from "./types/BuildResult.ts";

export default function build(
	root: BaseNode,
	options: { arch?: "c" | "aarch64"; platform?: string; audit?: boolean } = {},
): BuildResult {
	let status: BuildStatus = {
		root,
		structs: [],
		traits: [],
		enums: [],
		bitsets: [],
		headers: "",
		code: "",
		scoped_declarations: [],
		interpolate_string_counts: new Set(),
		strings: new Map(),
		float_literals: new Map(),
		string_literal_names: new Set(),
		class_decl_frame: new Map(),
		class_alias_vars: new Set(),
		alias_owns_flag: new Map(),
		ref_class_slots: new Map(),
		audit: options.audit,
		platform: options.platform ?? default_platform(),
		emitted_struct_bodies: new Set(),
	};

	if (options.arch === "aarch64") {
		reset_value_string_counter();
		reset_op_string_counter();
		reset_if_label_counter();
		reset_for_label_counter();
		reset_while_label_counter();
		reset_func_label_counter();
		reset_access_temp_counter();
		reset_func_call_temp_counter();
		reset_inline_counter();
		status.heap_returning_functions = scan_heap_returning_functions(root);
		status.inline_functions = scan_inline_candidates(root);
		status.heap_returning_functions.add("int_to_string");
		status.heap_returning_functions.add("uint_to_string");
		status.heap_returning_functions.add("int8_to_string");
		status.heap_returning_functions.add("uint8_to_string");
		status.heap_returning_functions.add("int16_to_string");
		status.heap_returning_functions.add("uint16_to_string");
		status.heap_returning_functions.add("int32_to_string");
		status.heap_returning_functions.add("uint32_to_string");
		status.heap_returning_functions.add("int64_to_string");
		status.heap_returning_functions.add("uint64_to_string");
		status.heap_returning_functions.add("float_to_string");
		status.heap_returning_functions.add("float32_to_string");
		status.heap_returning_functions.add("float64_to_string");
		status.heap_returning_functions.add("bool_to_string");
		status.heap_returning_functions.add("char_to_string");
		build_aarch64_node(root, status);
		if (status.strings && status.strings.size > 0) {
			status.code += "\n";
			for (const [label, value] of status.strings) {
				const escaped = value.replace(/\n/g, "\\n");
				status.code += `${label}: .asciz ${escaped}\n`;
			}
		}
		if (status.float_literals && status.float_literals.size > 0) {
			status.code += "\n.p2align 2\n";
			for (const [label, value] of status.float_literals) {
				status.code += `${label}: .double ${value}\n`;
			}
		}
		// Generate _string_interpolate_N helpers for aarch64
		for (const length of status.interpolate_string_counts) {
			status.code += `\n.p2align 2\n`;
			status.code += `_string_interpolate_${length}:\n`;
			status.code += `stp x29, x30, [sp, #-16]!\n`;
			status.code += `mov x29, sp\n`;
			// Stack layout: args at #0..#48, length at #56, str at #64, pattern at #72
			status.code += `sub sp, sp, #80\n`;
			status.code += `str x0, [sp, #72]\n`;
			const argRegs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
			for (let i = 0; i < length && i < argRegs.length; i++) {
				status.code += `str ${argRegs[i]}, [sp, #${i * 8}]\n`;
			}
			// Call snprintf(NULL, 0, pattern, args...)
			status.code += `mov x0, xzr\n`;
			status.code += `mov x1, xzr\n`;
			status.code += `ldr x2, [sp, #72]\n`;
			const variadicRegs = ["x3", "x4", "x5", "x6", "x7"];
			for (let i = 0; i < length && i < variadicRegs.length; i++) {
				status.code += `ldr ${variadicRegs[i]}, [sp, #${i * 8}]\n`;
			}
			status.code += `bl _snprintf\n`;
			status.code += `add x0, x0, #1\n`;
			status.code += `str x0, [sp, #56]\n`;
			emit_malloc(status);
			status.code += `str x0, [sp, #64]\n`;
			status.code += `ldr x0, [sp, #64]\n`;
			status.code += `ldr x1, [sp, #56]\n`;
			status.code += `ldr x2, [sp, #72]\n`;
			for (let i = 0; i < length && i < variadicRegs.length; i++) {
				status.code += `ldr ${variadicRegs[i]}, [sp, #${i * 8}]\n`;
			}
			status.code += `bl _snprintf\n`;
			status.code += `ldr x0, [sp, #64]\n`;
			status.code += `add sp, sp, #80\n`;
			status.code += `ldp x29, x30, [sp], #16\n`;
			status.code += `ret\n`;
		}
		if (options.audit) {
			// The main-function audit_check + pool shutdown hook is emitted
			// directly by build_function_node (it knows main's return label).
			//
			// Raw assembly blocks in the library (e.g. int_to_string) call
			// _malloc/_free directly. Wrap them so the audit counter stays
			// balanced.
			status.code = status.code.replaceAll("bl _malloc\n", "bl _echo_malloc_wrap\n");
			status.code = status.code.replaceAll("bl _free\n", "bl _echo_free_wrap\n");
		}
	} else {
		build_c_node(root, status);
		if (options.audit) {
			// Route the C backend through audit_runtime.c (the same runtime
			// aarch64 uses): wrap every malloc/calloc/realloc/free/strdup so
			// the balanced counter in echo_*_wrap tracks allocations, and
			// declare the wrappers + echo_audit_check (which main calls at
			// exit — see build_function_node). check_output links
			// audit_runtime.o and fails the test on any "LEAK:" output.
			//
			// Both status.code AND status.headers must be wrapped: the pool
			// infrastructure (emitted by build_spawn_node) lives in headers
			// and uses raw malloc/free. Without wrapping those, the audit
			// counter would be unbalanced (pool frees wouldn't decrement).
			status.code = wrap_c_allocators(status.code);
			// Prepend declarations so they appear before the pool code that
			// uses them, then wrap the rest of the headers.
			status.headers =
				`void *echo_malloc_wrap(unsigned long);\n` +
				`void *echo_calloc_wrap(unsigned long, unsigned long);\n` +
				`void *echo_realloc_wrap(void *, unsigned long);\n` +
				`void echo_free_wrap(void *);\n` +
				`void *echo_strdup_wrap(const char *);\n` +
				`void echo_audit_check(void);\n` +
				wrap_c_allocators(status.headers);
		}
	}

	let companion: string | undefined;
	// Generate the companion file when there's anything to put in it:
	// either aarch64_use_c raw-block functions, or file-scope C (pool
	// infrastructure, race-mode helpers) that the asm references via bl.
	if (
		(status.c_companion_functions && status.c_companion_functions.length > 0) ||
		status.file_scope_c
	) {
		companion = generate_companion(status.c_companion_functions ?? [], status);
	}
	// The companion C file contains the pool infrastructure (file_scope_c)
	// which uses raw malloc/free. Wrap them for audit so the counter stays
	// balanced. Must happen after companion generation (the pool code isn't
	// in status.code — it's in file_scope_c → companion).
	if (companion && options.audit) {
		companion = wrap_c_allocators(companion);
	}

	return {
		headers: status.headers,
		code: status.code,
		companion,
		errors: status.build_errors?.map((e) => ({ ...e, line: 0, column: 0 })),
	};
}

/** Derive a default target platform from the host when none is supplied. */
export function default_platform(): string {
	switch (process.platform) {
		case "darwin":
			return "macos";
		case "linux":
			return "linux";
		case "win32":
			return "windows";
		default:
			return process.platform;
	}
}

/**
 * Wrap every allocator/deallocator call in generated C so the audit runtime's
 * balanced counter (echo_malloc_count) tracks them. `\b` word boundaries make
 * this safe to run as a single pass: `echo_malloc_wrap(` already has a `_`
 * (a word char) before `malloc`, so the regex won't re-match the substituted
 * text, and `calloc(`/`realloc(` don't contain `malloc(`. Used only under
 * audit — without it the C backend emits raw malloc/free (no counting).
 */
function wrap_c_allocators(code: string): string {
	return code
		.replace(/\bmalloc\(/g, "echo_malloc_wrap(")
		.replace(/\bcalloc\(/g, "echo_calloc_wrap(")
		.replace(/\brealloc\(/g, "echo_realloc_wrap(")
		.replace(/\bfree\(/g, "echo_free_wrap(")
		.replace(/\bstrdup\(/g, "echo_strdup_wrap(");
}
