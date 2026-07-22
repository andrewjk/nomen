import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { struct_needs_destroy_by_name } from "./build_auto_free.ts";
import build_node from "./build_node.ts";
import build_parameter_node from "./build_parameter_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import { has_flag_name, is_nullable_struct_type } from "./utils/nullable_struct.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_declaration_node(node: DeclarationNode, status: BuildStatus) {
	// TODO: malloc() if it's on the heap

	// Function type declaration
	if (node.func_params) {
		build_function_type_declaration(node, status);
		return;
	}

	// HACK: Move the array part of a declaration after the variable name if applicable
	// If it's an array of traits, make it contain pointers
	if (
		node.type.is_array &&
		status.traits.find((t) => t.name === node.type.name) &&
		node.value &&
		node.value.node_type === "array"
	) {
		const array_values = node.value as ArrayValuesNode;
		// Support GCC by defining vars first
		const variables: string[] = [];
		let i = 1;
		for (let value of array_values.values) {
			const var_type = type_from_value_node(value);
			const var_name = `_${node.name}_${i}`;
			status.scoped_declarations.push(
				new DeclarationNode(node.start, node.visibility, node.declaration, var_name, var_type),
			);
			// HACK:
			status.code += `${c_type(var_type.name)} ${var_name} = `;
			build_node(value, status);
			status.code += ";\n";
			i += 1;
			variables.push(var_name);
		}

		// Then build the array
		status.code += `void *${node.name}[`;
		if (node.type.length) {
			build_node(node.type.length, status);
		}
		status.code += `] = {${variables.map((v) => `&${v}`).join(", ")}}`;
	} else {
		const safe_name = c_function_name(node.name);
		const mono_name = node.type.type_args?.length
			? `${node.type.name}_${node.type.type_args.map((t) => t.name).join("_")}`
			: node.type.name;
		const mono_struct = status.structs.find(
			(s) => s.name === mono_name && !s.is_simple_type && !s.is_generic,
		);
		const is_class_type = !!mono_struct?.is_class;
		// `var q = p` where p is a class variable creates an ALIAS (pointer
		// copy), not a fresh owner. Aliases must not be freed at scope exit —
		// the original declaration owns the instance. Detect this by checking
		// whether the initializer is a bare class-typed variable.
		// Likewise, `var Elephant cur = list.at(i)` initializes from a method
		// call (access node) that returns a BORROW — the instance is owned by
		// the container, not by this variable. Such borrows must not be freed
		// either. (Constructor calls and factory functions are `func_call`
		// nodes, which do transfer ownership.)
		// An `access` that is an ownership-transferring method (`mov out T`,
		// e.g. `list.pop()`) returns a fresh owned instance — it is NOT a borrow,
		// so the variable genuinely owns it and must be freed at scope exit.
		// Only treat a non-`owned_return` access as an alias/borrow.
		const val_is_owned_return =
			node.value?.node_type === "access" &&
			(node.value as AccessNode).access.node_type === "access_func" &&
			!!((node.value as AccessNode).access as AccessFunctionCallNode).owned_return;
		const val_is_class_alias =
			is_class_type &&
			((node.value?.node_type === "value" &&
				!!status.class_vars?.has((node.value as ValueNode).value)) ||
				(node.value?.node_type === "access" && !val_is_owned_return));
		// A `var string x = "literal"` where x is later reassigned ONLY to
		// borrowed values (e.g. `filename = init.args.at(1)`) must not strdup
		// the literal: x never owns a heap value, so a pre-emptive copy would
		// leak when the borrow branch isn't taken (auto_free can't tell at
		// scope exit whether the borrow happened). Treat the initial literal
		// like a borrow from the start — don't track it for free.
		// A `const string x = "literal"` is likewise never reassigned, so its
		// bare literal is never owned and must not be freed (freeing a string
		// literal is an invalid free / crash). Treat const literals as
		// borrow-only unconditionally.
		const val_is_string_literal =
			node.value?.node_type === "value" &&
			(node.value as ValueNode).value.length >= 2 &&
			(node.value as ValueNode).value.startsWith('"') &&
			(node.value as ValueNode).value.endsWith('"');
		const is_borrow_only_string =
			node.type.name === "string" &&
			val_is_string_literal &&
			(node.declaration === "const" ||
				(node.declaration === "var" && !!status.c_borrow_only_strings?.has(safe_name)));
		if (is_borrow_only_string) {
			if (!status.string_borrow_vars) status.string_borrow_vars = new Set();
			status.string_borrow_vars.add(safe_name);
		}
		if (!val_is_class_alias && !is_borrow_only_string) {
			status.scoped_declarations.push(node);
			// Track owned string vars in a set that persists across scope
			// resets (unlike scoped_declarations). A reassignment inside a
			// loop body (`s = s + "x"`) needs to know the outer `s` is an
			// owned string so it can free the old value each iteration.
			if (node.type?.name === "string" && !node.type.is_array) {
				if (!status.owned_string_vars) status.owned_string_vars = new Set();
				status.owned_string_vars.add(safe_name);
			}
		} else {
			// Record this as an object-level alias (`var R q = p`): it does
			// not own its current value until reassigned, so a later
			// reassignment must NOT destroy the shared old instance (unlike a
			// genuine owner, even one declared in an outer scope). This set
			// persists across scope resets, so it survives loop bodies.
			if (!status.class_alias_vars) status.class_alias_vars = new Set();
			status.class_alias_vars.add(safe_name);
			// Track the source variable as aliased so that a later
			// reassignment of the source (`a = Box(99)`) does NOT eagerly
			// free the old instance — the alias (`b`) still references it.
			if (node.value?.node_type === "value") {
				const src_name = (node.value as ValueNode).value;
				if (status.class_vars?.has(src_name)) {
					if (!status.aliased_class_sources) status.aliased_class_sources = new Set();
					status.aliased_class_sources.add(src_name);
					// Record which alias declaration(s) point at this source, so
					// a later reassignment of the source can transfer ownership
					// of the old instance to the alias (freed once at scope exit).
					if (!status.class_alias_source_map) status.class_alias_source_map = new Map();
					const list = status.class_alias_source_map.get(src_name) ?? [];
					list.push(node);
					status.class_alias_source_map.set(src_name, list);
				}
			}
		}
		// `var List b = mov a` (struct mov): ownership transfers from a to b.
		// Remove the source `a` from scoped_declarations so it won't be
		// destroyed at scope exit (b owns the data now).
		if (node.value?.node_type === "value" && (node.value as ValueNode).is_moved && !is_class_type) {
			const src_name = (node.value as ValueNode).value;
			const src_idx = status.scoped_declarations.findIndex((d) => d.name === src_name);
			if (src_idx !== -1) status.scoped_declarations.splice(src_idx, 1);
		}
		if (node.type?.name) {
			if (!status.variable_types) status.variable_types = new Map();
			status.variable_types.set(safe_name, node.type);
		}
		if (is_class_type) {
			// Track class-typed vars so build_access_node uses `->` and
			// build_value_node does NOT emit `*` (the pointer IS the value).
			if (!status.class_vars) status.class_vars = new Set();
			status.class_vars.add(safe_name);
			// When a class var captures the result of a call that also
			// received a same-type class temporary as a non-mov arg (the
			// hoisted `_param_N` for e.g. `Box(5)`), the callee may return
			// that very instance (e.g. `return x ?? fallback`). Both the
			// result var and the temporary would then point at one
			// allocation and auto_free would double-free. The result var
			// supersedes the temporary, so drop the temporary from
			// scoped_declarations. Mirrors aarch64 consolidate_temp_anchors.
			if (node.value?.node_type === "func_call") {
				consolidate_temp_anchors(status, node.value as FunctionCallNode, node.type.name);
			}
		}
		// An Array<T> declaration backed by an array literal ([1, 2, 3]) or a
		// range literal (1..4, which expands to {1, 2, 3}) is a fixed-size
		// stack C array (e.g. `long nums[3] = {1, 2, 3}`). Any other initializer
		// (e.g. Array.with(...) which returns a heap pointer) or no initializer
		// at all is emitted as a pointer to the element type.
		const is_stack_array =
			node.type.is_array &&
			(node.value?.node_type === "array" || node.value?.node_type === "range");
		// Array from a function call (e.g. `var Box[] r = make_arr()`) is a
		// heap-allocated Array_<T> buffer pointer — not a stack C array. Only
		// apply this for function-call initializers; declarations with no value
		// or other initializer types fall through to the generic pointer path.
		// Note: a stack array is identified by `is_stack_array` (initializer is
		// an `array`/`range` literal) — not by the presence of a `length`, since
		// `Array.with(v, LITERAL_N)` also carries a compile-time length but is
		// still heap-allocated.
		const is_heap_array_from_call =
			node.type.is_array &&
			!is_stack_array &&
			(node.value?.node_type === "func_call" ||
				(node.value?.node_type === "access" &&
					(node.value as AccessNode).access.node_type === "access_func"));
		if (is_heap_array_from_call) {
			status.code += `struct Array_${node.type.name}* ${safe_name}`;
			if (!status.heap_array_vars) status.heap_array_vars = new Set();
			status.heap_array_vars.add(safe_name);
		} else if (is_class_type) {
			status.code += `struct ${mono_name} *${safe_name}`;
		} else if (mono_struct) {
			status.code += `struct ${mono_name} ${safe_name}`;
		} else if (node.type.is_array && !is_stack_array) {
			status.code += `${c_type(node.type.name)} *${safe_name}`;
			// A heap array emitted as a plain `T*` pointer (e.g. from
			// `Array.with(v, n)`, whose inferred type carries a runtime length
			// so it doesn't take the struct-header path above) is still
			// malloc'd and must be freed at scope exit. Register it for a plain
			// `free()`. Only do this when the initializer is a call (owned heap
			// result), not a borrow/reference.
			const is_call_init =
				node.value?.node_type === "func_call" ||
				(node.value?.node_type === "access" &&
					(node.value as AccessNode).access.node_type === "access_func");
			if (is_call_init) {
				if (!status.heap_array_vars) status.heap_array_vars = new Set();
				status.heap_array_vars.add(safe_name);
			}
		} else {
			status.code += `${c_type(node.type.name)} ${safe_name}`;
		}
		if (is_stack_array) {
			status.code += `[`;
			if (node.type.length) {
				build_node(node.type.length, status);
			} else {
				// Empty typed array with no initializer — emit a placeholder
				// size so the C declaration is valid (the variable is unused).
				status.code += `1`;
			}
			status.code += `]`;
		}
		// Register stack (fixed-size) C arrays whose elements own heap data
		// (string / class / struct needing destroy) so build_auto_free frees
		// each element at scope exit. The backing array itself is not malloc'd,
		// but each element was. The declaration above already emitted the
		// correct C form (`char*`, `struct Box*`, or a primitive `long`).
		if (is_stack_array) {
			const elem_name = node.type.name;
			const elem_struct = status.structs.find((s) => s.name === elem_name);
			const elem_is_class = !!elem_struct?.is_class;
			const elem_is_string = elem_name === "string";
			const elem_struct_needs_destroy =
				!elem_is_class &&
				!elem_is_string &&
				!!status.structs.find((s) => s.name === elem_name && !s.is_simple_type && !s.is_generic) &&
				struct_needs_destroy_by_name(elem_name, status);
			if (elem_is_string || elem_is_class || elem_struct_needs_destroy) {
				if (!status.stack_array_vars) status.stack_array_vars = new Set();
				status.stack_array_vars.add(safe_name);
				if (!status.stack_array_lengths) status.stack_array_lengths = new Map();
				// Capture the element-count expression text. `node.type.length`
				// is set for array-literal-backed stack arrays (e.g. the `3` in
				// `char* parts[3L]`); if absent, fall back to the value count.
				let len_text = "0";
				if (node.type.length) {
					const before = status.code.length;
					build_node(node.type.length, status);
					len_text = status.code.substring(before);
					status.code = status.code.substring(0, before);
				} else if (node.value?.node_type === "array") {
					len_text = String((node.value as ArrayValuesNode).values.length);
				}
				status.stack_array_lengths.set(safe_name, len_text);
			}
		}
		// Nullable struct value-type local: the struct value is stored normally
		// (above), and a companion `<name>_has` flag tracks nullness. Handle its
		// initialization here and skip the generic `= value` path below.
		if (is_nullable_struct_type(node.type, status)) {
			const flag = has_flag_name(safe_name);
			status.code += `;\nunsigned char ${flag} = 0`;
			if (node.value) {
				const is_null =
					node.value.node_type === "value" && (node.value as ValueNode).value === "null";
				if (!is_null) {
					status.code += `;\n${safe_name} = `;
					build_node(node.value, status);
					status.code += `;\n${flag} = 1`;
				}
			}
			return;
		}
		if (node.value) {
			// TODO: This should be in more places?? Or apply to more nodes?? Probably
			// in build_node -- if it's a returning node??
			if (
				node.value.node_type === "if" ||
				node.value.node_type === "match" ||
				node.value.node_type === "switch"
			) {
				status.code += ";\n";
				const old_return_assign = status.return_assign;
				status.return_assign = safe_name;
				build_node(node.value, status);
				status.return_assign = old_return_assign;
			} else {
				status.code += " = ";
				// A `var string` declared with a string literal must own a
				// heap-allocated copy: auto_free will free it at scope exit, and
				// freeing a string literal crashes. Emit strdup() (and bump the
				// audit counter) so the literal becomes heap-owned.
				// Likewise, `var string t = s` where `s` is another owned
				// (heap) string in this scope must strdup — otherwise `t` and
				// `s` would alias the same heap block and auto_free would
				// double-free it. Each owned string var must have its own copy.
				// Matches the aarch64 backend's `is_heap_alias` strdup.
				const val_node = node.value as ValueNode;
				const val_is_string_literal =
					node.value.node_type === "value" &&
					val_node.value.length >= 2 &&
					val_node.value.startsWith('"') &&
					val_node.value.endsWith('"');
				const val_is_heap_string_var =
					node.value.node_type === "value" &&
					!val_is_string_literal &&
					!!status.scoped_declarations.find((d) => d.name === val_node.value);
				if (
					node.declaration === "var" &&
					node.type.name === "string" &&
					(val_is_string_literal || val_is_heap_string_var) &&
					!is_borrow_only_string
				) {
					status.code += `strdup(`;
					build_node(node.value, status);
					status.code += `)`;
				} else {
					// Type erasure: when a class pointer is assigned to a
					// simple-typed variable (e.g. `var int v = value` in
					// List.set where value is T=Animal), cast the class
					// pointer to (long) to satisfy C's type system.
					const val_type = type_from_value_node(node.value);
					const val_value = node.value.node_type === "value" ? (node.value as ValueNode).value : "";
					const val_is_class =
						!!status.structs.find((s) => s.name === val_type?.name && s.is_class) ||
						!!status.class_vars?.has(val_value);
					const decl_is_simple = !status.structs.find(
						(s) => s.name === node.type.name && !s.is_simple_type,
					);
					if (val_is_class && decl_is_simple) {
						if (status.class_vars?.has(val_value)) {
							status.suppress_dereference = true;
						}
						status.code += `(long)`;
						build_node(node.value, status);
						status.suppress_dereference = false;
					} else {
						build_node(node.value, status);
					}
				}
			}
			// `var X b = mov obj.field swap <rep>`: the field's bytes were
			// copied into `b` above (transferring ownership). Now write the
			// replacement value back into the moved-out field so the field is
			// revalidated — otherwise the field still aliases `b`'s data and
			// the owner would double-free / corrupt it. Mirrors the aarch64
			// backend's decl-swap handling.
			if (node.swap && node.value.node_type === "access") {
				status.code += `;\n`;
				// Re-emit the field-access expression (e.g. `self->slots`) by
				// building the access node into status.code.
				const before_len = status.code.length;
				build_node(node.value, status);
				const field_access = status.code.substring(before_len);
				status.code = status.code.substring(0, before_len);
				status.code += `${field_access} = `;
				build_node(node.swap, status);
			}
		}
	}
}

/**
 * When a class-typed variable captures the result of a call that also
 * received a same-type class temporary as a non-mov arg (the hoisted
 * `_param_N` for e.g. `Box(5)`), the callee may return that very instance
 * (e.g. `return x ?? fallback`). Both the result var and the temporary
 * would then point at one allocation and auto_free would double-free. The
 * result variable supersedes the temporary, so drop the temporary from
 * scoped_declarations to consolidate to a single owner. Mirrors the
 * aarch64 backend's `consolidate_temp_anchors`.
 */
function consolidate_temp_anchors(
	status: BuildStatus,
	call_node: FunctionCallNode,
	result_type_name: string,
) {
	const is_class = !!status.structs.find((s) => s.name === result_type_name && s.is_class);
	if (!is_class) return;
	for (let i = 0; i < call_node.params.length; i++) {
		const p = call_node.params[i];
		if (p?.node_type !== "value") continue;
		if (call_node.mov_param_indices?.includes(i)) continue;
		const pname = (p as ValueNode).value;
		// Only hoisted call temporaries (_param_N) — plain variables may
		// still be used after the call and must keep their own cleanup.
		if (!pname.startsWith("_param_")) continue;
		if ((p as ValueNode).type?.name !== result_type_name) continue;
		const di = status.scoped_declarations.findIndex((d) => d.name === pname);
		if (di === -1) continue;
		status.scoped_declarations.splice(di, 1);
	}
}

function build_function_type_declaration(node: DeclarationNode, status: BuildStatus) {
	// If the value is a FunctionNode, build it as a regular function definition
	if (node.value && node.value.node_type === "func") {
		build_node(node.value, status);
		return;
	}

	// Otherwise, generate a function pointer declaration
	const return_type_name = node.func_return_type?.name || "void";
	status.code += `${c_type(return_type_name)} (*${node.name})(`;
	for (let i = 0; i < node.func_params!.length; i++) {
		if (i > 0) {
			status.code += ", ";
		}
		build_parameter_node(node.func_params![i], status);
	}
	status.code += `)`;
	if (node.value) {
		status.code += " = ";
		build_node(node.value, status);
	}
}
