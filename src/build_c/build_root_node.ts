import type BaseNode from "../nodes/BaseNode.ts";
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
	for (const key of Object.keys(node)) {
		if (key === "parent" || key === "scope") continue; // skip back-refs
		const v = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(v)) {
			for (const item of v) {
				if (item && typeof item === "object" && "node_type" in item) {
					collect_traits(item as BaseNode, acc);
				}
			}
		} else if (v && typeof v === "object" && "node_type" in v) {
			collect_traits(v as BaseNode, acc);
		}
	}
	return acc;
}

export default function build_root_node(node: RootNode, status: BuildStatus) {
	status.headers += `#include <stdint.h>\n`;
	status.code += `
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
	// system TU (every arity 1..7 so a user TU's interpolation always
	// resolves), the user TU emits only forward declarations. In "all" mode
	// (single TU) only the used arities are emitted (unchanged behaviour).
	const interpolate_counts =
		status.emit_mode === "user" || status.emit_mode === "system"
			? new Set([...status.interpolate_string_counts, 1, 2, 3, 4, 5, 6, 7])
			: status.interpolate_string_counts;
	for (let length of interpolate_counts) {
		let range = Array.from({ length }, (_, i) => i);
		// Fat-string ABI: the pattern and every rendered argument are
		// nomen_string values (the checker's interpolation rewrite routes
		// each `\{expr}` through `<T>.to_string`, which now returns a fat
		// string). snprintf only needs the NUL-terminated .ptr halves; the
		// result's length is snprintf's own return — no strlen anywhere.
		let declaration = `nomen_string _string_interpolate_${length}(nomen_string pattern, ${range.map((n) => `nomen_string arg${n + 1}`).join(", ")})`;
		status.headers += `${declaration};\n`;
		if (status.emit_mode !== "user") {
			status.code += `${declaration}
{
    int length = snprintf(NULL, 0, pattern.ptr, ${range.map((n) => `arg${n + 1}.ptr`).join(", ")});
    char *str = malloc(length + 1);
    snprintf(str, length + 1, pattern.ptr, ${range.map((n) => `arg${n + 1}.ptr`).join(", ")});
    return (nomen_string){ str, (long)length };
}
`;
		}
	}
}
