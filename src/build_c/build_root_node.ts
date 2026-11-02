import { parse_interp_name } from "../check/utils/interp_arg_kinds.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import { child_nodes } from "../nodes/child_nodes.ts";
import RootNode from "../nodes/RootNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import build_block_node from "./build_block_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/** Recursively collect every TraitNode reachable from `node` (depth-first). */
function collect_traits(node: BaseNode, acc: TraitNode[] = []): TraitNode[] {
	if (!node) return acc;
	if (node.node_type === "trait") {
		acc.push(node as TraitNode);
	}
	for (const child of child_nodes(node)) {
		collect_traits(child, acc);
	}
	return acc;
}

export default function build_root_node(node: RootNode, status: BuildStatus) {
	status.headers += `#include <stdint.h>\n`;
	// Closure descriptors (CLOSURE.md) — the struct must precede
	// every function prototype: a tag first appearing inside a prototype has
	// prototype scope in C, and a later file-scope definition would be a
	// DIFFERENT type (conflicting-types errors at every func-param
	// signature).
	status.headers += `#ifndef NOMEN_CLOSURE_STRUCT\n#define NOMEN_CLOSURE_STRUCT\nstruct nomen_closure { void *code; void *env; int owned; void (*destroy_env)(void *); };\n#endif\n`;
	status.code += `
// Feature-test macro: must precede every system include so the whole TU
// agrees on one definition of ucontext_t (the fiber runtime embeds it).
// Without this, headers included earlier pin the small (pointer-mcontext)
// layout while libSystem's ucontext entry points write the full one — the
// fiber context allocation then overruns by hundreds of bytes.
#ifndef _XOPEN_SOURCE
#define _XOPEN_SOURCE 600
#endif
#pragma STDC FP_CONTRACT OFF
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include "main.h"

`.trimStart();

	// Forward-declare every trait BEFORE any struct/function signature that
	// references it. A monomorphized container's method signatures use
	// `struct <Trait> *` (the trait-typed value is a pointer to a
	// heap-allocated, vtable-bearing struct — see build_struct_node /
	// build_return_node); without an early file-scope forward declaration,
	// the C compiler treats each per-function mention of `struct Speaker` as
	// a distinct local type and the link fails with "conflicting types" or
	// "declaration will not be visible outside of this function".
	//
	// `status.traits` is populated lazily during build_block_node (via
	// gather_structs on each block — only direct children, not nested), so
	// at this point it is still empty. Walk the AST instead to find every
	// trait (including ones declared inside a function body, which is where
	// the test harness puts them via parse_with_imports).
	const fwd_traits = new Set<string>();
	for (const trait of collect_traits(node)) {
		if (fwd_traits.has(trait.name)) continue;
		fwd_traits.add(trait.name);
		status.headers += `struct ${trait.name};\n`;
	}

	build_block_node(node, status);

	// Lambda (anonymous function) definitions captured during the body walk:
	// C may not nest a function definition inside an expression, so
	// build_lambda_value buffered them. Flushing at file scope after the
	// statement walk is valid C — main.h carries their prototypes.
	if (status.lambda_definitions) {
		status.code += status.lambda_definitions;
		status.lambda_definitions = undefined;
	}
	// Closure thunks (named functions used as func values —
	// CLOSURE.md) flush at file scope like lambda definitions;
	// headers carry their prototypes and the static descriptors.
	if (status.closure_definitions) {
		status.code += status.closure_definitions;
		status.closure_definitions = undefined;
	}
	// `<Box_T>_box_clone` helpers (the Box-in-container fix) flush at file
	// scope like closure thunks — headers carry their prototypes.
	if (status.box_clone_definitions) {
		status.code += status.box_clone_definitions;
		status.box_clone_definitions = undefined;
	}
	// `<Enum>_<case>_init_take` variants (the enum-payload in-place tranche)
	// flush at file scope like box clones — headers carry their prototypes.
	if (status.enum_case_take_definitions) {
		status.code += status.enum_case_take_definitions;
		status.enum_case_take_definitions = undefined;
	}

	// Apple ObjC framework imports (Foundation/Cocoa) pull in MacTypes.h, which
	// defines `Point`, `Rect`, etc. and would collide with user-defined types
	// of the same name. Only emit them when the generated code actually
	// references ObjC runtime symbols (e.g. GUI code via `objc_msgSend`).
	const needs_objc =
		/\bobjc_msgSend\b|\bobjc_getClass\b|\bsel_registerName\b/.test(status.code) ||
		/\bobjc_msgSend\b|\bobjc_getClass\b|\bsel_registerName\b/.test(status.headers);
	if (needs_objc && (status.platform === "macos" || status.platform === "ios")) {
		status.headers =
			`#import <Foundation/Foundation.h>\n` +
			`#include <objc/runtime.h>\n` +
			`#include <objc/message.h>\n` +
			(status.platform === "macos" ? `#import <Cocoa/Cocoa.h>\n` : `#import <UIKit/UIKit.h>\n`) +
			status.headers;
	}

	status.headers += "void **_get_trait_func(void **obj, int trait_index, int func_index);\n";
	// `_get_trait_func` is shared runtime. Its definition lives in the system
	// TU; the user TU only needs the (already-emitted) forward declaration.
	if (status.emit_mode !== "user") {
		status.code += `
void **_get_trait_func(void **obj, int trait_index, int func_index)
{
    void **vt = *obj;
    // Slot 0 of _<Struct>_traits is the destroy-funcs pointer (reserved so a
    // trait-typed collection can dispatch destroy polymorphically). Real trait
    // tables start at index 1, so shift trait_index by 1.
    void **trait = *(vt + 1 + trait_index);
    void **func = *(trait + func_index);
    return func;
}  
`;
	}

	// For every trait, emit a `<Trait>_destroy(void *obj)` shim that dispatches
	// through the destroy slot at index 0 of the struct's vtable. This makes
	// the T_destroy reference inside ClassBuffer<Trait>'s raw #destroy block
	// (substituted to `<Trait>_destroy`) resolve to a real symbol that reaches
	// the actual conforming struct's destroy. Without this, a trait-typed
	// collection would either fail to link or call a non-existent symbol.
	// `status.traits` can carry duplicates today (gather_structs pushes per-
	// block, and conformance by multiple structs to the same trait can re-add
	// it via different paths), so dedupe by name here to avoid redefinition.
	const emitted_trait_destroys = new Set<string>();
	for (const trait of status.traits) {
		if (emitted_trait_destroys.has(trait.name)) continue;
		// Partition by trait origin across the TU split: a system trait's shim
		// is defined in the system TU, a user trait's in the user TU (matching
		// where the referencing ClassBuffer<Trait> lands).
		if (status.emit_mode === "system" && !trait.is_library) continue;
		if (status.emit_mode === "user" && trait.is_library) continue;
		emitted_trait_destroys.add(trait.name);
		const header_sig = `void ${trait.name}_destroy(void *obj)`;
		status.headers += `${header_sig};\n`;
		status.code += `${header_sig}\n`;
		status.code += `{\n`;
		status.code += `    void **vt = *(void **)obj;\n`;
		status.code += `    void **destroy_funcs = (void **)vt[0];\n`;
		status.code += `    if (destroy_funcs) {\n`;
		status.code += `        void (*destroy)(void *) = (void (*)(void *))*destroy_funcs;\n`;
		status.code += `        if (destroy) destroy(obj);\n`;
		status.code += `    }\n`;
		status.code += `}\n`;
	}

	// `_string_interpolate_N` is shared runtime: definitions live in the
	// system TU (arities 1..7 — the arities the library itself can use, so a
	// user TU's <=7-arg interpolation always resolves). The system TU cannot
	// enumerate every USER arity, so the user TU defines its own arities past
	// 7 (mirroring the aarch64 helpers). In "all" mode (single TU) only the
	// used arities are emitted (unchanged behaviour).
	const interpolate_counts =
		status.emit_mode === "user" || status.emit_mode === "system"
			? new Set([...status.interpolate_string_counts, 1, 2, 3, 4, 5, 6, 7])
			: status.interpolate_string_counts;
	for (let length of interpolate_counts) {
		let range = Array.from({ length }, (_, i) => i);
		// Fat-string ABI: the pattern and every rendered argument are
		// nomen_string values. The result is built in ONE pass with an
		// EXACT size, not printf: every `%s` in the pattern is exactly two
		// pattern bytes and expands to that argument's byte length, so the
		// length is known from the fat pairs alone (pattern.len - 2*N +
		// Σ arg.len) — no sizing scan and no format interpretation. One
		// malloc, then literal runs and argument bytes are copied straight
		// in. (A literal '%' in the source text is copied verbatim; the old
		// snprintf body consumed it as a format directive.)
		let declaration = `nomen_string _string_interpolate_${length}(nomen_string pattern, ${range.map((n) => `nomen_string arg${n + 1}`).join(", ")})`;
		status.headers += `${declaration};\n`;
		if (status.emit_mode !== "user" || length > 7) {
			const arg_array = range.map((n) => `arg${n + 1}`).join(", ");
			status.code += `${declaration}
{
    nomen_string args[${length}] = { ${arg_array} };
    long total = pattern.len - ${2 * length};
    for (int i = 0; i < ${length}; i++) total += args[i].len;
    char *str = (char *)malloc((size_t)total + 1);
    char *dst = str;
    const char *src = pattern.ptr;
    const char *end = pattern.ptr + pattern.len;
    int ai = 0;
    while (src < end) {
        if (*src == '%' && src + 1 < end && src[1] == 's' && ai < ${length}) {
            nomen_string a = args[ai++];
            memcpy(dst, a.ptr, (size_t)a.len);
            dst += a.len;
            src += 2;
        } else {
            *dst++ = *src++;
        }
    }
    *dst = 0;
    return (nomen_string){ str, (long)(dst - str) };
}
`;
		}
	}

	// Writer-form interpolation helpers (PERF_PLAN items 10/8 remainder):
	// one per kind-mix the TU calls (`_string_interpolate_<arity>_<kinds>`).
	// A numeric argument (`i` signed int / `u` unsigned / `f` float — every
	// float family is a 64-bit double) renders into a per-argument stack
	// scratch — the append_int digit loop (magnitude via the two's-
	// complement negate, so INT64_MIN is exact); ONE `%f` snprintf per
	// float (the item's hand-rolled-`%f` exclusion) — and every argument
	// then walks as a (ptr, len) pair: the unsuffixed helper's copy walk,
	// unchanged. Each mixed helper is C-STATIC and emitted in EVERY mode:
	// the system TU cannot enumerate mixes, so no cross-TU resolution
	// exists (the static also keeps a library mix and a user mix from
	// colliding at link time).
	for (const mixed_name of [...status.interpolate_mixed].sort()) {
		const { arity, kinds } = parse_interp_name(mixed_name);
		if (!kinds || kinds.length !== arity) continue;
		const params = kinds.map((k, n) =>
			k === "s"
				? `nomen_string arg${n + 1}`
				: k === "i"
					? `long long arg${n + 1}`
					: k === "u"
						? `unsigned long long arg${n + 1}`
						: `double arg${n + 1}`,
		);
		const declaration = `nomen_string ${mixed_name}(nomen_string pattern, ${params.join(", ")})`;
		// The forward declaration always goes to the header (which the code
		// file includes at the top) — the runtime section is emitted after
		// the user/library bodies, so every call site needs it. A static
		// DECLARATION without a definition in this TU is not warned.
		status.headers += `${declaration.replace(/^nomen_string /, "static nomen_string ")};\n`;
		const range = Array.from({ length: arity }, (_, i) => i);
		status.code += `${declaration.replace(/^nomen_string /, "static nomen_string ")}\n`;
		status.code += `{\n`;
		status.code += `    const char *ptrs[${arity}];\n`;
		status.code += `    long lens[${arity}];\n`;
		for (const n of range) {
			const k = kinds[n];
			const arg = `arg${n + 1}`;
			if (k === "s") {
				status.code += `    ptrs[${n}] = ${arg}.ptr; lens[${n}] = ${arg}.len;\n`;
			} else if (k === "f") {
				status.code += `    char scratch_f${n}[360];\n`;
				status.code += `    lens[${n}] = snprintf(scratch_f${n}, sizeof(scratch_f${n}), "%f", ${arg});\n`;
				status.code += `    ptrs[${n}] = scratch_f${n};\n`;
			} else {
				status.code += `    char scratch_${n}[24];\n`;
				status.code += `    {\n`;
				status.code += `        int pos = 24;\n`;
				if (k === "i") {
					status.code += `        // Magnitude via the two's-complement negate (u stays correct for INT64_MIN).\n`;
					status.code += `        unsigned long long u = ${arg} < 0 ? (unsigned long long)(-(${arg} + 1LL)) + 1ULL : (unsigned long long)${arg};\n`;
				} else {
					status.code += `        unsigned long long u = (unsigned long long)${arg};\n`;
				}
				status.code += `        do {\n`;
				status.code += `            scratch_${n}[--pos] = (char)('0' + (int)(u % 10));\n`;
				status.code += `            u /= 10;\n`;
				status.code += `        } while (u != 0);\n`;
				if (k === "i") {
					status.code += `        if (${arg} < 0) scratch_${n}[--pos] = '-';\n`;
				}
				status.code += `        ptrs[${n}] = scratch_${n} + pos; lens[${n}] = 24 - pos;\n`;
				status.code += `    }\n`;
			}
		}
		status.code += `    long total = pattern.len - ${2 * arity};\n`;
		for (const n of range) status.code += `    total += lens[${n}];\n`;
		status.code += `    char *str = (char *)malloc((size_t)total + 1);\n`;
		status.code += `    char *dst = str;\n`;
		status.code += `    const char *src = pattern.ptr;\n`;
		status.code += `    const char *end = pattern.ptr + pattern.len;\n`;
		status.code += `    int ai = 0;\n`;
		status.code += `    while (src < end) {\n`;
		status.code += `        if (*src == '%' && src + 1 < end && src[1] == 's' && ai < ${arity}) {\n`;
		status.code += `            int k = ai++;\n`;
		status.code += `            memcpy(dst, ptrs[k], (size_t)lens[k]);\n`;
		status.code += `            dst += lens[k];\n`;
		status.code += `            src += 2;\n`;
		status.code += `        } else {\n`;
		status.code += `            *dst++ = *src++;\n`;
		status.code += `        }\n`;
		status.code += `    }\n`;
		status.code += `    *dst = 0;\n`;
		status.code += `    return (nomen_string){ str, (long)(dst - str) };\n`;
		status.code += `}\n`;
	}
}
