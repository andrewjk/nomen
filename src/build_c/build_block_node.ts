import emission_label from "../build_common/emission_label.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import { has_return_statement } from "../build_common/string_return_analysis.ts";
import { SIMPLE_TYPES } from "../built_in_types.ts";
import BitsetNode from "../nodes/BitsetNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import { is_function_node, is_struct_node, is_trait_node } from "../nodes/check_node_type.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import EnumNode from "../nodes/EnumNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import build_bitset_node from "./build_bitset_node.ts";
import build_enum_node from "./build_enum_node.ts";
import build_function_node from "./build_function_node.ts";
import build_node from "./build_node.ts";
import build_struct_body from "./build_struct_body.ts";
import build_struct_node from "./build_struct_node.ts";
import build_trait_node from "./build_trait_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import emit_allocations from "./utils/emit_allocations.ts";
import { should_emit_definition } from "./utils/is_system_definition.ts";

export default function build_block_node(
	node: BlockNode,
	status: BuildStatus,
	with_declarations = true,
) {
	// Gather structs, traits and funcs that might be used before they are declared
	gather_structs(node, status);

	// Names of top-level non-primitive `const` declarations (e.g. geometry
	// type constants like `DEFAULT_PARAMS`) that are inlined at every use site
	// by `build_value_node` rather than emitted as a file-scope global — the
	// initializer is typically a struct constructor call, which is not a
	// valid file-scope constant expression in C. The statement loop below
	// skips these declarations; uses resolve them through
	// `status.top_level_consts`.
	const inlined_const_names = new Set<string>();
	if (node.node_type === "root") {
		for (const child of node.statements) {
			if (child.node_type !== "declare") continue;
			const decl = child as DeclarationNode;
			if (decl.declaration !== "const") continue;
			if (!decl.type?.name || !decl.value) continue;
			if (SIMPLE_TYPES.includes(decl.type.name)) continue;
			if (decl.type.is_array) continue;
			inlined_const_names.add(decl.name);
			if (!status.top_level_consts) status.top_level_consts = new Map();
			status.top_level_consts.set(decl.name, decl);
		}
	}

	// Pre-pass: record every user function that returns an OWNED heap string
	// (a computed/concatenated result, not a borrowed field). Callers use this
	// (build_auto_free / build_return_node) to free the result at scope exit
	// and to avoid redundant strdup. Runs before any function body is built so
	// a call is correctly classified even when the callee is defined later.
	gather_heap_returning_functions(node, status);

	// When called from inside a function body (e.g. main), skip struct/function
	// declarations — they're already emitted at file scope by the root's
	// build_block_node call and would produce invalid C if nested inside a function.
	if (with_declarations) {
		// Emit all struct forward declarations to headers before building anything,
		// so that function declarations can reference struct types not yet built.
		// Recurse into function bodies (commonly `main`) so that a type nested
		// inside a function is forward-declared before a monomorphized struct
		// hoisted to root scope references it (e.g. `struct Box<T>{var T item}`
		// monomorphized to `Box_Point`, where `Point` lives inside `main`).
		// Mirrors the recursion in gather_structs.
		const forward_declared = new Set<string>();
		const forward_declare = (block: BlockNode) => {
			for (let child of block.statements) {
				if (is_struct_node(child)) {
					const struct = child as StructNode;
					if (!struct.is_simple_type && !struct.is_generic && !forward_declared.has(struct.name)) {
						forward_declared.add(struct.name);
						status.headers += `struct ${struct.name};\n`;
					}
				} else if ((child as any).node_type === "func") {
					const func = child as FunctionNode;
					if (func.statements?.length) forward_declare(func);
				}
			}
		};
		forward_declare(node);

		// Pass 1: Emit all struct bodies first so that all types are fully defined
		// before any struct functions are emitted (which may access fields of other structs).
		// Structs are emitted in dependency order: if struct A has a by-value field
		// of struct B, B is emitted first (C requires complete types for by-value fields).
		// Pass 1: emit struct typedefs, gated by origin. System struct typedefs
		// are routed to the system TU's HEADERS (system.h) so the user TU reaches
		// them via `#include "system.h"` for by-value use; user struct typedefs
		// stay in the user TU. (See emit_struct_in_order for the header swap.)
		const emitted_structs = new Set<StructNode>();
		for (let child of node.statements) {
			if (is_struct_node(child)) {
				if (
					!should_emit_definition(
						child,
						status.emit_mode,
						status.structs,
						status.system_struct_names,
					)
				)
					continue;
				emit_struct_in_order(child as StructNode, status, emitted_structs);
			}
		}

		// Pass 2: Build traits, then enums/bitsets, then struct functions, then functions
		for (let child of node.statements) {
			if (is_trait_node(child)) {
				if (
					!should_emit_definition(
						child,
						status.emit_mode,
						status.structs,
						status.system_struct_names,
					)
				)
					continue;
				build_trait_node(child, status);
			}
		}

		for (let child of node.statements) {
			if (child.node_type === "enum") {
				if (
					!should_emit_definition(
						child,
						status.emit_mode,
						status.structs,
						status.system_struct_names,
					)
				)
					continue;
				build_enum_node(child as EnumNode, status);
			}
		}

		for (let child of node.statements) {
			if (child.node_type === "bitset") {
				if (
					!should_emit_definition(
						child,
						status.emit_mode,
						status.structs,
						status.system_struct_names,
					)
				)
					continue;
				build_bitset_node(child as BitsetNode, status);
			}
		}

		for (let child of node.statements) {
			if (is_struct_node(child)) {
				if (
					!should_emit_definition(
						child,
						status.emit_mode,
						status.structs,
						status.system_struct_names,
					)
				)
					continue;
				build_struct_node(child, status);
			}
		}

		// Emit forward declarations for top-level primitive constants (e.g.
		// `const float ln10 = ...`) so function bodies can reference them.
		// The actual definitions remain after functions in the remaining loop.
		// Only run at the root level — inner blocks (if/while/for bodies) also
		// default to with_declarations=true but their locals must not be
		// forward-declared as globals. Non-primitive `const` declarations are
		// NOT forward-declared here — they're inlined at use sites (see
		// `inlined_const_names` above) so they have no file-scope global.
		if (node.node_type === "root") {
			for (let child of node.statements) {
				if (child.node_type === "declare") {
					const decl = child as DeclarationNode;
					if (!decl.func_params && SIMPLE_TYPES.includes(decl.type.name)) {
						if (decl.type.is_array) {
							// A global fixed-size array (e.g. `const nums = Array(1, 2, 3)`
							// lowered to `long nums[3] = {...}`) is defined after the
							// functions (see the statement loop below). Forward-declare it
							// as an incomplete array so functions compiled earlier can
							// subscript it (e.g. `nums.at(0)` → `nums[0]`).
							status.headers += `extern ${c_type(decl.type.name)} ${c_function_name(
								decl.name,
							)}[];\n`;
						} else {
							status.headers += `extern ${c_type(decl.type.name)} ${c_function_name(decl.name)};\n`;
						}
					}
				}
			}
		}

		for (let child of node.statements) {
			if (is_function_node(child)) {
				if (
					!should_emit_definition(
						child,
						status.emit_mode,
						status.structs,
						status.system_struct_names,
					)
				)
					continue;
				build_function_node(child, status);
			}
		}
	}

	// Build the block's statements
	for (let child of node.statements) {
		if (
			!is_trait_node(child) &&
			!is_struct_node(child) &&
			!is_function_node(child) &&
			child.node_type !== "enum" &&
			child.node_type !== "bitset" &&
			!(child.node_type === "declare" && inlined_const_names.has((child as DeclarationNode).name))
		) {
			// Root-scope globals carry linker symbols; route them by origin so a
			// user global isn't also emitted into the system TU (duplicate
			// symbol) and vice-versa. Locals inside a function body are emitted
			// with their enclosing function regardless of mode.
			if (
				node.node_type === "root" &&
				child.node_type === "declare" &&
				!should_emit_definition(child, status.emit_mode, status.structs, status.system_struct_names)
			) {
				continue;
			}
			emit_allocations(child, status);
			build_node(child, status, true);
		}
	}
}

function gather_structs(block: BlockNode, status: BuildStatus) {
	for (let node of block.statements) {
		switch (node.node_type) {
			case "struct": {
				const struct = node as StructNode;
				status.structs.push(struct);
				break;
			}
			case "trait": {
				const trait = node as TraitNode;
				status.traits.push(trait);
				break;
			}
			case "enum": {
				status.enums.push(node as EnumNode);
				break;
			}
			case "bitset": {
				status.bitsets.push(node as BitsetNode);
				break;
			}
			case "func": {
				// Recurse into function bodies: user-defined types nested inside
				// a function (commonly `main`) must be in status.structs before
				// monomorphized generics that reference them are built.
				const func = node as FunctionNode;
				if (func.statements?.length) {
					gather_structs(func, status);
				}
				break;
			}
		}
	}
}

function gather_heap_returning_functions(block: BlockNode, status: BuildStatus) {
	if (!status.heap_returning_functions) status.heap_returning_functions = new Set();
	// The C backend strdup's EVERY string return before handing it to the
	// caller: literals (`return "x"` → strdup), borrowed field accesses
	// (`return self.name` → strdup), method/func calls already produce a
	// fresh heap string, and match/switch/if returns are strdup'd too (see
	// build_return_node). So any path through a string-returning function
	// transfers ownership of a heap string to the caller — register the
	// function unconditionally. (The precise borrow-vs-owned classification
	// exists in build_common/string_return_analysis.ts and is stamped on the
	// FunctionNode (`returns_string_borrow`); the C backend's boundary-strdup
	// contract makes every return owned regardless, so it is not consulted
	// here.)
	const visit = (func: FunctionNode) => {
		if (func.return_type?.name === "string" && func.name && has_return_statement(func)) {
			func.returns_string_borrow = false;
			status.heap_returning_functions!.add(c_function_name(emission_label(func)));
		}
		for (const stmt of func.statements ?? []) {
			if (is_function_node(stmt)) visit(stmt as FunctionNode);
		}
	};
	const visit_method = (struct_name: string, func: FunctionNode) => {
		if (func.return_type?.name !== "string" || !func.name) return;
		if (has_return_statement(func)) {
			const method_c_name = func.name.replace(/#/g, "");
			status.heap_returning_functions!.add(`${struct_name}_${method_c_name}`);
		}
	};
	for (const node of block.statements) {
		if (is_function_node(node)) {
			visit(node as FunctionNode);
		} else if (is_struct_node(node)) {
			const struct = node as StructNode;
			for (const fn of struct.functions ?? []) {
				visit_method(struct.name, fn as FunctionNode);
			}
		}
	}
}

function emit_struct_in_order(struct: StructNode, status: BuildStatus, emitted: Set<StructNode>) {
	if (emitted.has(struct)) return;
	if (struct.is_generic || struct.is_simple_type) return;
	emitted.add(struct);

	// Emit dependencies first: any by-value struct field needs the referenced
	// struct to be fully defined beforehand. Generic field types (e.g.
	// Map<int,int>) are monomorphized to concrete names (Map_int_int), so
	// resolve the monomorphized name when looking up the dependency.
	for (const field of struct.fields) {
		const mono_name = mono_type_name(field.type);
		const dep = status.structs.find(
			(s) => s.name === mono_name && !s.is_simple_type && !s.is_generic,
		);
		if (dep && !emitted.has(dep)) {
			emit_struct_in_order(dep, status, emitted);
		}
	}

	// In system mode, route the typedef to HEADERS (system.h) via the same
	// buffer-swap build_struct_node uses for by-value returns. The user TU
	// `#include`s system.h, so it sees System struct definitions for by-value
	// use (e.g. `struct File r = File_init()`) without those definitions
	// leaking user-type references into the system TU.
	if (status.emit_mode === "system") {
		const swap = status.code;
		status.code = status.headers;
		build_struct_body(struct, status);
		status.headers = status.code;
		status.code = swap;
	} else {
		build_struct_body(struct, status);
	}
}
