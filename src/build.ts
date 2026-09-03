import { optimize_frame_slots, run_float_forwarding } from "./build_aarch64/asm_opt.ts";
import { reset_access_temp_counter } from "./build_aarch64/build_access_node.ts";
import { reset_decl_const_counters } from "./build_aarch64/build_declaration_node.ts";
import { reset_label_counter as reset_for_label_counter } from "./build_aarch64/build_for_loop_node.ts";
import { reset_temp_counter as reset_func_call_temp_counter } from "./build_aarch64/build_function_call_node.ts";
import { reset_label_counter as reset_func_label_counter } from "./build_aarch64/build_function_node.ts";
import { reset_label_counter as reset_if_label_counter } from "./build_aarch64/build_if_else_node.ts";
import { reset_inline_counter } from "./build_aarch64/build_inline_method.ts";
import { reset_label_counter as reset_match_label_counter } from "./build_aarch64/build_match_node.ts";
import build_aarch64_node from "./build_aarch64/build_node.ts";
import { reset_string_counter as reset_op_string_counter } from "./build_aarch64/build_operation_node.ts";
import { reset_label_counter as reset_switch_label_counter } from "./build_aarch64/build_switch_node.ts";
import { reset_string_counter as reset_value_string_counter } from "./build_aarch64/build_value_node.ts";
import { reset_label_counter as reset_while_label_counter } from "./build_aarch64/build_while_loop_node.ts";
import { validate_asm, validate_stack_balance } from "./build_aarch64/lift_asm.ts";
import { reset_neon_counter } from "./build_aarch64/neon_emit.ts";
import { emit_malloc } from "./build_aarch64/utils/audit.ts";
import { generate_companion } from "./build_aarch64/utils/c_companion.ts";
import { scan_heap_returning_functions } from "./build_aarch64/utils/scan_heap_returns.ts";
import { scan_inline_candidates } from "./build_aarch64/utils/scan_inline_candidates.ts";
import { reset_string_field_counter } from "./build_c/build_assignment_node.ts";
import { reset_ns_default_counter } from "./build_c/build_function_call_node.ts";
import { reset_match_temp_counter } from "./build_c/build_match_node.ts";
import build_c_node from "./build_c/build_node.ts";
import { reset_ns_tmp_counter } from "./build_c/build_operation_node.ts";
import type BuildStatus from "./build_c/BuildStatus.ts";
import { set_c_typedef_mangling } from "./build_c/utils/c_type.ts";
import { optimize_asm } from "./build_common/optimize_asm.ts";
import { scan_borrow_returning_functions } from "./build_common/scan_borrow_returns.ts";
import BaseNode from "./nodes/BaseNode.ts";
import RawNode from "./nodes/RawNode.ts";
import type BuildResult from "./types/BuildResult.ts";

export default function build(
	root: BaseNode,
	options: {
		arch?: "c" | "aarch64";
		platform?: string;
		audit?: boolean;
		emit_mode?: "all" | "system" | "user";
		system_struct_names?: Set<string>;
		/** Release mode: run the optimization passes over the generated code.
		 *  For the aarch64 backend this is the asm-level equivalent of the
		 *  clang -O2 the C backend receives at link time (clang's optimizer
		 *  never sees the assembly — it goes straight to the assembler). */
		optimize?: boolean;
		/** Opt in to FP reassociation (the analog of clang's `-ffast-math`
		 *  reduction behavior): float loop reductions (`acc = acc + …`)
		 *  vectorize under NEON, which changes summation order — results may
		 *  differ in the last ulp vs the scalar loop. Everything else
		 *  (elementwise vectorization) is bit-exact and unaffected. */
		fast_math?: boolean;
	} = {},
): BuildResult {
	let status: BuildStatus = {
		root,
		structs: [],
		traits: [],
		enums: [],
		bitsets: [],
		headers: "",
		code: "",
		emit_mode: options.emit_mode ?? "all",
		system_struct_names: options.system_struct_names,
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
		fast_math: options.fast_math,
		platform: options.platform ?? default_platform(),
		emitted_struct_bodies: new Set(),
		vtable_data: "",
	};

	// Reset per build so the C-backend-only typedef-mangling flag never leaks
	// across build() calls (e.g. a prior GUI C build leaving it on for a later
	// aarch64 build, which would corrupt the companion's primitive c_type
	// lookups). The C branch below re-enables it when this build pulls in ObjC.
	set_c_typedef_mangling(false);

	// Reset the C backend's module-level temp counters so two builds in the
	// same process are byte-identical (the NIR emission tests require this;
	// the aarch64 counters below get the same treatment).
	reset_string_field_counter();
	reset_ns_default_counter();
	reset_match_temp_counter();
	reset_ns_tmp_counter();

	if (options.arch === "aarch64") {
		reset_value_string_counter();
		reset_op_string_counter();
		reset_if_label_counter();
		reset_for_label_counter();
		reset_while_label_counter();
		reset_func_label_counter();
		reset_match_label_counter();
		reset_switch_label_counter();
		reset_access_temp_counter();
		reset_func_call_temp_counter();
		reset_inline_counter();
		reset_decl_const_counters();
		reset_neon_counter();
		status.heap_returning_functions = scan_heap_returning_functions(root);
		status.borrow_returning_functions = scan_borrow_returning_functions(root);
		status.inline_functions = scan_inline_candidates(root);
		build_aarch64_node(root, status);
		// For every trait, emit a `<Trait>_destroy` shim that dispatches
		// through the destroy slot at index 0 of the struct's vtable. This
		// makes the T_destroy reference inside ClassBuffer<Trait>'s raw
		// #destroy block (substituted to `<Trait>_destroy`) resolve to a real
		// symbol that reaches the actual conforming struct's destroy. Without
		// it, a trait-typed heterogeneous collection (e.g. ClassBuffer<Speaker>
		// of `Dog`/`Cat`) would fail to link. Dedupe by name —
		// status.traits can carry duplicates today (gather_structs pushes per-
		// block, and conformance by multiple structs to the same trait can
		// re-add it via different paths).
		const emitted_trait_destroys = new Set<string>();
		for (const trait of status.traits) {
			if (emitted_trait_destroys.has(trait.name)) continue;
			// Partition destroy shims by trait origin so they land in the same
			// TU as the ClassBuffer<Trait> that references them (a system trait
			// collection is always System-origin → system TU; a user trait
			// collection → user TU). Avoids duplicate symbols across TUs.
			if (status.emit_mode === "system" && !trait.is_library) continue;
			if (status.emit_mode === "user" && trait.is_library) continue;
			emitted_trait_destroys.add(trait.name);
			const label = `${trait.name}_destroy`;
			const end_label = `.L${label}_end`;
			status.code += `\n.p2align 2\n`;
			status.code += `${label}:\n`;
			status.code += `stp x29, x30, [sp, #-16]!\n`;
			status.code += `ldr x9, [x0]\n`; // x9 = *obj = vtable
			status.code += `ldr x9, [x9]\n`; // x9 = vtable[0] = destroy_funcs ptr
			status.code += `cbz x9, ${end_label}\n`;
			status.code += `ldr x9, [x9]\n`; // x9 = destroy_funcs[0] = destroy fn ptr
			status.code += `cbz x9, ${end_label}\n`;
			status.code += `blr x9\n`; // call destroy(obj); x0 still holds obj
			status.code += `${end_label}:\n`;
			status.code += `ldp x29, x30, [sp], #16\n`;
			status.code += `ret\n`;
		}
		if (status.vtable_data) {
			// Vtable data holds absolute relocations (`.quad function_symbol`),
			// which macOS arm64 forbids in the read-only __TEXT segment. Emit
			// it in the __DATA segment and switch back to __TEXT afterwards so
			// the trailing string literals and interpolate helpers stay in code.
			status.code += ".data\n";
			status.code += status.vtable_data;
			status.code += ".text\n";
		}
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
		// Generate _string_interpolate_N helpers for aarch64. These are shared
		// runtime: definitions live in the system TU (covering every arity so a
		// user TU's interpolation always resolves at link), and the user TU
		// emits none (its `bl _string_interpolate_N` is an extern reference).
		const emit_mode = status.emit_mode ?? "all";
		const interpolate_lengths: number[] =
			emit_mode === "user"
				? []
				: emit_mode === "system"
					? Array.from(new Set([...status.interpolate_string_counts, 1, 2, 3, 4, 5, 6, 7])).sort(
							(a, b) => a - b,
						)
					: Array.from(status.interpolate_string_counts);
		for (const length of interpolate_lengths) {
			status.code += `\n.p2align 2\n`;
			// In the system TU these are referenced by the user TU, so export
			// them (build_function_node already globalizes real functions via
			// its `_alias` mechanism; these tail helpers are emitted directly).
			if (emit_mode === "system") {
				status.code += `.globl _string_interpolate_${length}\n`;
			}
			status.code += `_string_interpolate_${length}:\n`;
			status.code += `stp x29, x30, [sp, #-16]!\n`;
			status.code += `mov x29, sp\n`;
			// Fat-string ABI: pattern = (x0 ptr, x1 len); arg_i = (ptr, len)
			// register pairs starting at x2. Only the NUL-terminated ptr
			// halves feed snprintf. Stack layout: unpacked arg ptrs at
			// #0..#48, length at #56, str at #64, pattern ptr at #72.
			status.code += `sub sp, sp, #80\n`;
			status.code += `str x0, [sp, #72]\n`;
			const pairRegs = [
				["x2", "x3"],
				["x4", "x5"],
				["x6", "x7"],
			];
			for (let i = 0; i < length && i < pairRegs.length; i++) {
				status.code += `str ${pairRegs[i][0]}, [sp, #${i * 8}]\n`;
			}
			// Pairs past x7 arrived in the caller's outgoing area: at the bl,
			// pair k (k >= 3) sits at [caller_sp + (k-3)*16]. Inside the
			// helper, x29 = entry_sp - 16 (the stp push), so the ptr half is
			// at [x29, #(16 + (k-3)*16)].
			for (let i = 3; i < length; i++) {
				status.code += `ldr x9, [x29, #${16 + (i - 3) * 16}]\n`;
				status.code += `str x9, [sp, #${i * 8}]\n`;
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
			// Return the fat pair: x1 = the rendered length (snprintf's own
			// return — no strlen), then x0 = buffer.
			status.code += `mov x1, x0\n`;
			status.code += `ldr x0, [sp, #64]\n`;
			status.code += `add sp, sp, #80\n`;
			status.code += `ldp x29, x30, [sp], #16\n`;
			status.code += `ret\n`;
		}
		// Release mode: run the optimization pipeline over the whole
		// aarch64 program (constant folding/propagation, dead-branch folding,
		// strength reduction, dead-code elimination, peepholes). This is the
		// asm-level equivalent of the clang -O2 the C backend receives at
		// link time — the .s is assembled verbatim, so the passes must be
		// done in-codegen. Runs before audit wrapping so the `bl _malloc`
		// rewrites below see unmodified call sites.
		if (options.optimize) {
			status.code = optimize_asm(status.code);
		}
		// Phase-2 IR pass: frame-slot forwarding + dead-store elimination on
		// the lifted assembly. Runs unconditionally so every build (and every
		// test binary) exercises it; the validator below then re-checks the
		// rewritten text.
		status.code = optimize_frame_slots(status.code);
		// Phase-2 sibling: float-bits forwarding — collapses the d0 call
		// protocol's `fmov xN, dM … fmov dK, xN` crossings into direct
		// d↔d moves (see asm_opt.ts). Same unconditional/validated contract.
		status.code = run_float_forwarding(status.code);
		if (options.audit) {
			// The main-function audit_check + pool shutdown hook is emitted
			// directly by build_function_node (it knows main's return label).
			//
			// Raw assembly blocks in the library (e.g. int_to_string,
			// StringBuilder_to_string) call _malloc/_realloc/_strdup/_calloc/
			// _free directly. Wrap them so the audit counter stays balanced —
			// an unwrapped allocation whose eventual free IS wrapped would
			// read as a phantom over-free. Mirrors wrap_c_allocators on the C
			// side (nomen_realloc_wrap only counts a null old_ptr, matching
			// realloc's malloc-equivalence).
			status.code = status.code.replaceAll("bl _malloc\n", "bl _nomen_malloc_wrap\n");
			status.code = status.code.replaceAll("bl _calloc\n", "bl _nomen_calloc_wrap\n");
			status.code = status.code.replaceAll("bl _realloc\n", "bl _nomen_realloc_wrap\n");
			status.code = status.code.replaceAll("bl _strdup\n", "bl _nomen_strdup_wrap\n");
			status.code = status.code.replaceAll("bl _free\n", "bl _nomen_free_wrap\n");
		}
		// Validate the final assembly (lift it into structured form and check
		// mnemonic shapes, branch targets, flag discipline, stack balance).
		// A backend emission bug fails the build here with the offending line
		// instead of surfacing as an assembler error or silent miscompile.
		const lift_errors = validate_asm(status.code);
		if (lift_errors.length > 0) {
			if (!status.build_errors) status.build_errors = [];
			for (const e of lift_errors.slice(0, 20)) {
				status.build_errors.push({
					message: `asm: ${e.message} — ${e.text.trim()}`,
					start: 0,
				});
			}
		}
		// Stack-balance validation (the deferred phase-1 check, now per-block):
		// sp must return to its entry value at each `ret`. Joins with unequal
		// path deltas become unknown (never error) — the classic epilogue-diamond
		// pattern stays clean while straight-line imbalance fails loudly.
		const balance_errors = validate_stack_balance(status.code);
		if (balance_errors.length > 0) {
			if (!status.build_errors) status.build_errors = [];
			for (const e of balance_errors.slice(0, 20)) {
				status.build_errors.push({
					message: `asm: ${e.message} — ${e.text.trim()}`,
					start: 0,
				});
			}
		}
	} else {
		// Scan-detected borrow-returning functions (a class-typed return that
		// hands back a container element) steer BOTH backends' declaration
		// ownership — see build_c/build_declaration_node's
		// val_is_borrowing_call.
		status.borrow_returning_functions = scan_borrow_returning_functions(root);
		// GUI builds `#import` Apple frameworks (Cocoa/UIKit) which drag in
		// MacTypes.h, whose typedefs (`Size`, `Point`, …) collide with Nomen's
		// own struct/enum typedefs. Detect that situation up front (it depends
		// only on raw `#arch` blocks referencing the objc runtime) and mangle
		// user typedef names with `nm_` for this build, keeping struct tags
		// unchanged. See `set_c_typedef_mangling` / `c_typedef_name`. Mirrors
		// the aarch64 companion's strategy. Off for every non-GUI program.
		set_c_typedef_mangling(build_needs_objc(root, status.platform));
		build_c_node(root, status);
		// A `view T` is a non-owning, non-escaping (ptr, len) slice into a
		// container's buffer. Every view — `view string`, `view int`, `view
		// User`, ... — lowers to the same C struct; the element type lives in
		// the Nomen `Type` (used to cast `ptr` on `.at`), not in the struct.
		// Defined up front so any view reference (notably a slice method's
		// #arch body, emitted whenever System is imported) compiles.
		//
		// `string` is the fat 16-byte { char* ptr; long len; } value. The
		// buffer is NUL-terminated at ptr[len] (libc/FFI keep working);
		// `.length` is a `.len` field load. nomen_str_dup deep-copies (the
		// copy owns its heap buffer — the input keeps its own); raw #arch
		// bodies see a thin char* via _raw_ adapters (build_raw_node).
		status.code =
			`typedef struct { void* ptr; long len; } nomen_view;\n` +
			`typedef struct { char* ptr; long len; } nomen_string;\n` +
			`#define nomen_str_lit(s, n) ((nomen_string){ (s), (long)(n) })\n` +
			`#include <string.h>\n` +
			// In audit mode wrap_c_allocators rewrites this strdup to
			// nomen_strdup_wrap — declare it before use (the definition lives
			// in audit_runtime.o, linked separately).
			(options.audit ? `void *nomen_strdup_wrap(const char *);\n` : "") +
			`static nomen_string nomen_str_dup(nomen_string s) {\n` +
			`\tnomen_string r = { strdup(s.ptr), s.len };\n` +
			`\treturn r;\n` +
			`}\n` +
			status.code;
		if (options.audit) {
			// Route the C backend through audit_runtime.c (the same runtime
			// aarch64 uses): wrap every malloc/calloc/realloc/free/strdup so
			// the balanced counter in nomen_*_wrap tracks allocations, and
			// declare the wrappers + nomen_audit_check (which main calls at
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
				`void *nomen_malloc_wrap(unsigned long);\n` +
				`void *nomen_calloc_wrap(unsigned long, unsigned long);\n` +
				`void *nomen_realloc_wrap(void *, unsigned long);\n` +
				`void nomen_free_wrap(void *);\n` +
				`void *nomen_strdup_wrap(const char *);\n` +
				`void nomen_audit_check(void);\n` +
				wrap_c_allocators(status.headers);
		}
		// In user mode the system TU owns the System type definitions and the
		// shared runtime helpers; the user TU references them through this
		// include. (The system TU is compiled to a cached object first, so
		// system.h is on disk before the user TU is compiled.)
		if (status.emit_mode === "user") {
			status.headers = `#include "system.h"\n` + status.headers;
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

/**
 * Build both translation units of the System-lib tiering split in one call:
 * the precompilable `system` TU (non-generic System code + System-instantiated
 * generics) and the per-program `user` TU (user code + user-typed generics +
 * the program's literals/vtables). Returns a BuildResult whose `code`/`headers`
 * are the user TU and whose `system_code`/`system_headers` are the system TU.
 * The harness compiles the system TU once (cached by content hash) and links it
 * with every user TU that needs the same System subset — so a codegen change
 * affecting only user emission keeps the cached system object warm. Plain
 * `build()` (single TU, `emit_mode` undefined) is unchanged.
 */
export function build_split(
	root: BaseNode,
	options: {
		arch?: "c" | "aarch64";
		platform?: string;
		audit?: boolean;
		optimize?: boolean;
	} = {},
): BuildResult {
	const platform = options.platform ?? default_platform();
	// GUI (ObjC) builds use file-scope raw C blocks (resize callbacks, etc.)
	// whose emission is hard to partition cleanly across TUs, and they're rare
	// + already slow (Apple-framework linking). Fall back to a single TU so the
	// split stays robust for the ~99% non-GUI case that benefits from caching.
	if (build_needs_objc(root, platform)) {
		return build(root, options);
	}
	const sys = build(root, { ...options, emit_mode: "system" });
	const usr = build(root, { ...options, emit_mode: "user" });
	// Companions (aarch64_use_c raw C / pool infra) may originate on either
	// side; concatenate so the linked binary sees both.
	const companions = [sys.companion, usr.companion].filter(Boolean) as string[];
	return {
		headers: usr.headers,
		code: usr.code,
		system_code: sys.code,
		system_headers: sys.headers,
		companion: companions.length ? companions.join("\n") : undefined,
		errors: [...(usr.errors ?? []), ...(sys.errors ?? [])],
	};
}

/**
 * Derive a default target platform from the host when none is supplied.
 */
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
 * Whether a top-level definition belongs in the precompilable System
 * translation unit. Re-exported from the shared util so build_block_node
 * (both backends) and build.ts share one implementation without a circular
 * import. See `src/build_c/utils/is_system_definition.ts`.
 */
export { default as is_system_definition } from "./build_c/utils/is_system_definition.ts";

/**
 * Wrap every allocator/deallocator call in generated C so the audit runtime's
 * balanced counter (nomen_malloc_count) tracks them. `\b` word boundaries make
 * this safe to run as a single pass: `nomen_malloc_wrap(` already has a `_`
 * (a word char) before `malloc`, so the regex won't re-match the substituted
 * text, and `calloc(`/`realloc(` don't contain `malloc(`. Used only under
 * audit — without it the C backend emits raw malloc/free (no counting).
 */
function wrap_c_allocators(code: string): string {
	return code
		.replace(/\bmalloc\(/g, "nomen_malloc_wrap(")
		.replace(/\bcalloc\(/g, "nomen_calloc_wrap(")
		.replace(/\brealloc\(/g, "nomen_realloc_wrap(")
		.replace(/\bfree\(/g, "nomen_free_wrap(")
		.replace(/\bstrdup\(/g, "nomen_strdup_wrap(");
}

/**
 * Whether the C backend's single translation unit will end up `#import`ing
 * Apple's ObjC frameworks (Foundation/Cocoa/UIKit), matching the
 * `needs_objc` gate in build_c/build_root_node.ts. That gate keys off objc
 * runtime symbols (`objc_msgSend`/`objc_getClass`/`sel_registerName`) in the
 * emitted code — and those symbols only ever originate from raw `#arch: c`
 * blocks (the codegen never synthesises objc calls), so scanning the AST's
 * raw nodes before building is equivalent. Used to decide whether to mangle
 * user typedef names (see set_c_typedef_mangling) so they don't collide with
 * MacTypes.h.
 */
export function build_needs_objc(root: BaseNode, platform: string): boolean {
	if (platform !== "macos" && platform !== "ios") return false;
	return ast_uses_objc(root);
}

const OBJC_RE = /\bobjc_msgSend\b|\bobjc_getClass\b|\bsel_registerName\b/;

function ast_uses_objc(node: BaseNode | undefined | null): boolean {
	if (!node) return false;
	if (node.node_type === "raw" && OBJC_RE.test((node as RawNode).value)) {
		return true;
	}
	for (const key of Object.keys(node)) {
		if (key === "parent" || key === "scope") continue; // skip back-refs
		const v = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(v)) {
			for (const item of v) {
				if (item && typeof item === "object" && "node_type" in item) {
					if (ast_uses_objc(item as BaseNode)) return true;
				}
			}
		} else if (v && typeof v === "object" && "node_type" in v) {
			if (ast_uses_objc(v as BaseNode)) return true;
		}
	}
	return false;
}
