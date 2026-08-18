import emit_field_overrides from "../build/emit_field_overrides.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import {
	collect_expression_branch_values,
	is_owned_string_branch_value,
} from "../build_common/string_return_analysis.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_array_values_node from "./build_array_values_node.ts";
import { struct_needs_destroy_by_name } from "./build_auto_free.ts";
import build_node from "./build_node.ts";
import build_parameter_node from "./build_parameter_node.ts";
import build_range_node, { evaluate_constant } from "./build_range_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import { has_flag_name, is_nullable_struct_type } from "./utils/nullable_struct.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_declaration_node(node: DeclarationNode, status: BuildStatus) {
	// TODO: malloc() if it's on the heap

	// Function type declaration (explicit `var func (...) f = ...` or inferred
	// `var f = Console.write` where the checker resolved the type to "func"
	// with func_params/func_return_type on node.type).
	if (node.func_params || node.type.name === "func") {
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
		const mono_name = mono_type_name(node.type);
		const mono_struct = status.structs.find(
			(s) => s.name === mono_name && !s.is_simple_type && !s.is_generic,
		);
		const is_class_type = !!mono_struct?.is_class;
		// A trait-typed local holds a concrete struct value (the initializer's
		// actual type). Declare it with the concrete struct's C type so the
		// by-value storage has the correct layout for vtable dispatch and the
		// generated field accessors (`get_<Concrete>_<field>` expect a
		// `struct Concrete *`). The Nomen type remains the trait (stored in
		// variable_types) so accesses are recognized as trait dispatch.
		let concrete_struct_name = "";
		const storage_is_trait_concrete =
			!mono_struct && !!status.traits.find((t) => t.name === node.type.name) && !!node.value;
		if (storage_is_trait_concrete && node.value) {
			const val_type = type_from_value_node(node.value);
			const val_struct = status.structs.find(
				(s) => s.name === val_type?.name && !s.is_simple_type && !s.is_generic,
			);
			if (val_struct) {
				concrete_struct_name = val_struct.name;
			}
		}
		// A trait-typed local whose concrete storage is a `class` holds a
		// pointer to the heap-allocated instance (not the inline struct).
		// Declare it as `void *` so it can be reassigned to any other class
		// conforming to the same trait. The vtable dispatch and field access
		// read through the stored pointer (the local is tracked in
		// class_vars so build_vtable_target passes it by value, not &name).
		// Scope-exit and reassignment reclaim via the trait's
		// `<Trait>_destroy` shim + free (the concrete type at runtime may
		// differ from the initializer's after reassignment, so destroy must
		// dispatch through the vtable rather than call a fixed concrete fn).
		if (
			storage_is_trait_concrete &&
			concrete_struct_name &&
			status.structs.find((s) => s.name === concrete_struct_name)?.is_class
		) {
			if (!status.class_vars) status.class_vars = new Set();
			status.class_vars.add(safe_name);
			if (!status.trait_class_locals) status.trait_class_locals = new Map();
			status.trait_class_locals.set(safe_name, node.type.name);
			if (node.type?.name) {
				if (!status.variable_types) status.variable_types = new Map();
				status.variable_types.set(safe_name, node.type);
			}
			status.scoped_declarations.push(node);
			status.code += `void *${safe_name}`;
			if (node.value) {
				status.code += ` = (void *)`;
				build_node(node.value, status);
			}
			status.code += `;\n`;
			return;
		}
		// A trait-typed local initialized from a method-call return (e.g.
		// `var Speaker p = pets.at(i)` or `var Speaker p = pets.pop()`)
		// holds a vtable-bearing class pointer the callee already
		// allocated — the concrete struct isn't statically known (the
		// method's declared return type is the trait), so storage must be
		// a pointer (`void *`) dispatched through the trait vtable. The
		// ClassBuffer<Trait> slot already stores a correct vtable-bearing
		// class pointer, so dispatch works once the local is tracked in
		// class_vars (build_vtable_target passes it by value, not &name)
		// and variable_types (so accesses are recognized as trait
		// dispatch). Ownership follows the callee's return convention: a
		// `mov out T` method (`owned_return`, e.g. `list.pop()`) transfers
		// ownership (destroy + free at scope exit via trait_class_locals);
		// a plain borrow (e.g. `.at(i)`) does not (the container still
		// owns the element), so the local is recorded as an alias and
		// never freed.
		const val_is_trait_method_return =
			storage_is_trait_concrete &&
			!concrete_struct_name &&
			node.value?.node_type === "access" &&
			(node.value as AccessNode).access.node_type === "access_func";
		if (val_is_trait_method_return) {
			const inner = (node.value as AccessNode).access as AccessFunctionCallNode;
			if (!status.class_vars) status.class_vars = new Set();
			status.class_vars.add(safe_name);
			if (!status.trait_class_locals) status.trait_class_locals = new Map();
			status.trait_class_locals.set(safe_name, node.type.name);
			if (node.type?.name) {
				if (!status.variable_types) status.variable_types = new Map();
				status.variable_types.set(safe_name, node.type);
			}
			if (inner.owned_return) {
				status.scoped_declarations.push(node);
			} else {
				if (!status.class_alias_vars) status.class_alias_vars = new Set();
				status.class_alias_vars.add(safe_name);
			}
			status.code += `void *${safe_name}`;
			if (node.value) {
				status.code += ` = (void *)`;
				build_node(node.value, status);
			}
			status.code += `;\n`;
			return;
		}
		// `var ref T x = y` declares x as a pointer to y (mutable alias).
		// Emit `T *x = &y` and track x in function_ref_params so accesses
		// use `->` and value-uses dereference. Ref locals don't own data,
		// so they are NOT added to scoped_declarations.
		if (node.type.is_ref && !node.type.is_array) {
			if (mono_struct) {
				status.code += `struct ${mono_name} *${safe_name}`;
			} else {
				status.code += `${c_type(node.type.name)} *${safe_name}`;
			}
			if (node.value) {
				status.code += ` = &`;
				build_node(node.value, status);
			}
			status.code += `;\n`;
			if (!status.function_ref_params) status.function_ref_params = new Set();
			status.function_ref_params.add(safe_name);
			if (!status.ref_local_vars) status.ref_local_vars = new Set();
			status.ref_local_vars.add(safe_name);
			if (node.type?.name) {
				if (!status.variable_types) status.variable_types = new Map();
				status.variable_types.set(safe_name, node.type);
			}
			return;
		}
		// `var q = p` where p is a class variable creates an ALIAS (pointer
		// copy), not a fresh owner. Aliases must not be freed at scope exit —
		// the original declaration owns the instance. Likewise, `var Elephant
		// cur = list.at(i)` initializes from a method call (access node) that
		// returns a BORROW — the instance is owned by the container, not by
		// this variable. Such borrows must not be freed either. (Constructor
		// calls and factory functions are `func_call` nodes, which transfer
		// ownership — EXCEPT scan-detected borrow-returning functions like
		// `box_at`, whose class return is a container reference the callee's
		// owner frees.)
		// An `access` that is an ownership-transferring method (`mov out T`,
		// e.g. `list.pop()`) returns a fresh owned instance — it is NOT a borrow,
		// so the variable genuinely owns it and must be freed at scope exit.
		// Only treat a non-`owned_return` access as an alias/borrow.
		const val_is_owned_return =
			node.value?.node_type === "access" &&
			(node.value as AccessNode).access.node_type === "access_func" &&
			!!((node.value as AccessNode).access as AccessFunctionCallNode).owned_return;
		const val_is_borrowing_call =
			node.value?.node_type === "func_call" &&
			!!status.borrow_returning_functions?.has((node.value as FunctionCallNode).name);
		const val_is_class_alias =
			is_class_type &&
			((node.value?.node_type === "value" &&
				!!status.class_vars?.has((node.value as ValueNode).value)) ||
				val_is_borrowing_call ||
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
		if (!val_is_class_alias && !is_borrow_only_string && !node.type.is_view) {
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
		// An `int[]`/`int[N]`/literal-backed declaration is a fixed-size stack C
		// array (e.g. `long nums[3] = {1, 2, 3}`). A heap `Array<T>` declaration
		// (`is_array_heap`, e.g. `var Array<int> x = [2,4,6]`) is NOT a stack
		// array — it materialises as a heap `struct Array_<T>*` buffer (handled
		// by the literal/range heap path below). Any other initializer
		// (e.g. Array.with(...) which returns a heap pointer) or no initializer
		// at all is emitted as a pointer to the element type.
		const is_stack_array =
			node.type.storage_kind === "stack_array" &&
			!node.is_heap_array_literal &&
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
			!!node.type.is_array &&
			!is_stack_array &&
			(node.value?.node_type === "func_call" ||
				(node.value?.node_type === "access" &&
					(node.value as AccessNode).access.node_type === "access_func") ||
				(node.value?.node_type === "op" &&
					!!(node.value as OperationNode).operator_func?.struct_name?.startsWith("Array")));
		if (is_heap_array_from_call) {
			status.code += `struct Array_${node.type.name}* ${safe_name}`;
			if (!status.heap_array_vars) status.heap_array_vars = new Set();
			status.heap_array_vars.add(safe_name);
		} else if (
			node.is_heap_array_literal ||
			node.is_heap_array_copy ||
			// A heap `Array<T>` declared with a literal/range initializer
			// (`var Array<int> x = [2,4,6]` / `= 1 .. 3`) — not a hoisted temp,
			// but the same heap-buffer materialisation.
			(node.type.storage_kind === "heap_array" &&
				(node.value?.node_type === "array" || node.value?.node_type === "range"))
		) {
			// A hoisted array-literal/range/stack-var copy temp bound to a heap
			// `Array<T>` param (see check_function_call): the temp must be a heap
			// `struct Array_<T>*` buffer so the promoted param's
			// `.length`/`.at`/`.set`/iteration dispatch through the Array_<T>
			// methods. Register it in `heap_array_vars` so auto_free frees the
			// buffer (and its owning elements) at scope exit. The malloc +
			// header + element copies are emitted with the initializer below.
			status.code += `struct Array_${node.type.name}* ${safe_name}`;
			if (!status.heap_array_vars) status.heap_array_vars = new Set();
			status.heap_array_vars.add(safe_name);
		} else if (is_class_type) {
			status.code += `struct ${mono_name} *${safe_name}`;
		} else if (concrete_struct_name) {
			status.code += `struct ${concrete_struct_name} ${safe_name}`;
		} else if (mono_struct) {
			status.code += `struct ${mono_name} ${safe_name}`;
		} else if (node.type.is_view) {
			// A `view T` local is a non-owning (ptr, len) slice on the stack.
			// It borrows from its source and is never auto-freed.
			status.code += `nomen_view ${safe_name}`;
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
					// A nullable struct function-call initializer
					// (`var T? x = f(...)`) writes both the struct value AND
					// the null/non-null flag through the hidden `_ret_has`
					// out-param — set status.current_nullable_call_flag so
					// build_function_call_node forwards `&<flag>` and the
					// callee writes the real null/non-null bit into it. Skip
					// the unconditional `<flag> = 1` otherwise.
					const value_is_nullable_call =
						node.value.node_type === "func_call" &&
						is_nullable_struct_type((node.value as FunctionCallNode).type, status);
					status.code += `;\n${safe_name} = `;
					if (value_is_nullable_call) {
						const old = status.current_nullable_call_flag;
						status.current_nullable_call_flag = flag;
						build_node(node.value, status);
						status.current_nullable_call_flag = old;
					} else {
						build_node(node.value, status);
						status.code += `;\n${flag} = 1`;
					}
				}
			}
			return;
		}
		if (node.value) {
			// A hoisted array-literal/range temp bound to a heap `Array<T>`
			// param, or a heap `Array<T>` declared directly with a literal/range
			// initializer (`var Array<int> x = [2,4,6]`): materialise a heap
			// `struct Array_<T>*` buffer (header + inline data) and copy the
			// literal's/range's elements in. `build_array_values_node`
			// strdup's string-literal elements, so each slot owns a heap copy
			// that auto_free reclaims at scope exit — matching how
			// `Array<T>.with`/`set` and stack string arrays are handled.
			const is_heap_literal_init =
				node.is_heap_array_literal ||
				(node.type.storage_kind === "heap_array" &&
					(node.value.node_type === "array" || node.value.node_type === "range"));
			if (is_heap_literal_init && node.value.node_type === "array") {
				const arr = node.value as ArrayValuesNode;
				const elem_name = node.type.name;
				const elem_c = heap_elem_c_type(elem_name, status);
				const count = arr.values.length;
				status.code += `;\n`;
				status.code += `${safe_name} = malloc(sizeof(struct Array_${elem_name}) + ${count}L * sizeof(${elem_c}));\n`;
				status.code += `${safe_name}->_vt = 0;\n`;
				status.code += `${safe_name}->length = ${count}L;\n`;
				status.code += `memcpy((char *)${safe_name} + sizeof(struct Array_${elem_name}), (${elem_c}[])`;
				build_array_values_node(arr, status);
				status.code += `, ${count}L * sizeof(${elem_c}));\n`;
				return;
			}
			if (is_heap_literal_init && node.value.node_type === "range") {
				const range = node.value as RangeNode;
				const elem_name = node.type.name;
				const elem_c = heap_elem_c_type(elem_name, status);
				const count = range_count_c(range);
				status.code += `;\n`;
				status.code += `${safe_name} = malloc(sizeof(struct Array_${elem_name}) + ${count}L * sizeof(${elem_c}));\n`;
				status.code += `${safe_name}->_vt = 0;\n`;
				status.code += `${safe_name}->length = ${count}L;\n`;
				status.code += `memcpy((char *)${safe_name} + sizeof(struct Array_${elem_name}), (${elem_c}[])`;
				build_range_node(range, status);
				status.code += `, ${count}L * sizeof(${elem_c}));\n`;
				return;
			}
			// A hoisted COPY temp for a stack-array variable arg bound to a
			// heap `Array<T>` param: materialise a heap buffer and copy the
			// source stack array's inline elements in. String elements are
			// strdup'd so the copy owns its own heap copies (the source's
			// stack-array cleanup frees its own) — no double-free. Class
			// elements are never copied (see is_heap_array_var_copy).
			if (node.is_heap_array_copy && node.value?.node_type === "value") {
				const src = node.value as ValueNode;
				const src_name = src.value;
				const src_type = type_from_value_node(node.value);
				const elem_name = node.type.name;
				const elem_c = heap_elem_c_type(elem_name, status);
				const count = src_type.length ? parseInt((src_type.length as ValueNode).value || "0") : 0;
				status.code += `;\n`;
				status.code += `${safe_name} = malloc(sizeof(struct Array_${elem_name}) + ${count}L * sizeof(${elem_c}));\n`;
				status.code += `${safe_name}->_vt = 0;\n`;
				status.code += `${safe_name}->length = ${count}L;\n`;
				if (elem_name === "string") {
					status.code += `{ char** _dst = (char**)((char *)${safe_name} + sizeof(struct Array_string)); char** _src = ${src_name}; for (long _i = 0; _i < ${count}L; _i++) { _dst[_i] = strdup(_src[_i]); } }\n`;
				} else {
					status.code += `memcpy((char *)${safe_name} + sizeof(struct Array_${elem_name}), ${src_name}, ${count}L * sizeof(${elem_c}));\n`;
				}
				return;
			}
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
				// Mixed string-join ownership normalization: when the join's
				// branches mix owned heap producers (interpolation/concat/
				// string-returning call) with non-owned values (literals,
				// variables, borrows), the inferred type may claim `static`
				// (the literal branch wins the is_static merge), so auto_free
				// would skip the variable and the owned branch's heap result
				// leaks. Flag the branch builds so every non-owned branch value
				// is strdup'd into an owned copy (build_let_node), and record
				// the variable as an owned string so auto_free frees it once at
				// scope exit. All-literal and all-owned joins are unchanged.
				const join_is_string =
					node.type.name === "string" && !node.type.is_view && !node.type.is_array;
				const any_branch_owned =
					join_is_string &&
					collect_expression_branch_values(node.value).some((v) =>
						is_owned_string_branch_value(v, status),
					);
				const old_join_owned = status.join_needs_owned_string;
				if (any_branch_owned) {
					status.join_needs_owned_string = true;
					if (!status.string_join_owned_vars) status.string_join_owned_vars = new Set();
					status.string_join_owned_vars.add(safe_name);
				}
				build_node(node.value, status);
				status.join_needs_owned_string = old_join_owned;
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
					!node.type.is_view &&
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
			// Named-field struct literal overrides (e.g. `[ grow = 2 ]` on a
			// struct whose `grow` field has a declared default) are applied as
			// post-construction field assignments after the constructor call
			// returned. Routing through build_assignment_node means value
			// structs, classes, struct-typed fields, and strings all reuse
			// the existing assignment path.
			if (node.value?.node_type === "func_call") {
				emit_field_overrides(safe_name, node.value, build_node, status, ";\n", ";\n");
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

	// Otherwise, generate a function pointer declaration.
	// Explicit syntax (`var func (string,) f`) stores params on the decl;
	// inferred type (`var f = Console.write`) stores them on node.type.
	const func_params = node.func_params || node.type.func_params || [];
	const func_return_type = node.func_return_type || node.type.func_return_type;
	const return_type_name = func_return_type?.name || "void";
	status.code += `${c_type(return_type_name)} (*${node.name})(`;
	for (let i = 0; i < func_params.length; i++) {
		if (i > 0) {
			status.code += ", ";
		}
		build_parameter_node(func_params[i], status);
	}
	status.code += `)`;
	if (node.value) {
		status.code += " = ";
		build_node(node.value, status);
	}
}

/**
 * The C element type for a heap `Array_<T>` buffer's inline data region
 * (`T`, `struct T` for a value struct, or `struct T*` for a class element).
 */
function heap_elem_c_type(elem_name: string, status: BuildStatus): string {
	const elem_struct = status.structs.find((s) => s.name === elem_name);
	if (elem_struct?.is_class) return `struct ${elem_name}*`;
	if (elem_struct && !elem_struct.is_simple_type) return `struct ${elem_name}`;
	return c_type(elem_name);
}

/**
 * The element count of a static range (`1..4` → 3). Dynamic-bound ranges
 * return 0 — they are not heap-wrapped (see the range-literal heap path).
 */
function range_count_c(range: RangeNode): number {
	const start = evaluate_constant(range.left_value);
	const end = evaluate_constant(range.right_value);
	if (start !== undefined && end !== undefined) return end - start;
	return 0;
}
