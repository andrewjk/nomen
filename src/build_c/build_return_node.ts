import emit_field_overrides from "../build/emit_field_overrides.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import {
	collect_expression_branch_values,
	is_owned_string_branch_value,
} from "../build_common/string_return_analysis.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_array_values_node from "./build_array_values_node.ts";
import build_auto_free from "./build_auto_free.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";
import emit_allocations from "./utils/emit_allocations.ts";
import is_string_borrow from "./utils/is_string_borrow.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_return_node(node: ReturnNode, status: BuildStatus) {
	// For a nullable struct return type, the callee signals null-ness to the
	// caller through the hidden `*_ret_has` out-parameter (0 = null,
	// 1 = value). Detect once: a bare `return` (void) only fires for non-nullable
	// returns (the type system rejects it), so just `return null` vs value.
	const ret_has = status.nullable_ret_has_param;
	const returns_nullable_struct = !!ret_has;
	const ret_is_null =
		returns_nullable_struct &&
		(!node.value ||
			(node.value.node_type === "value" && (node.value as ValueNode).value === "null"));
	if (returns_nullable_struct) {
		// For `return null`, signal null and return an uninitialised temp —
		// the caller won't read the struct value (the flag is 0). For a real
		// value, signal non-null first so the struct-return path below is
		// free to use _return_val normally.
		if (ret_is_null) {
			build_auto_free(status);
			status.code += `*${ret_has} = 0;\n`;
			status.code += `return (struct ${status.function_return_type!.name}){0};\n`;
			return;
		}
		status.code += `*${ret_has} = 1;\n`;
	}
	if (!node.value) {
		build_auto_free(status);
		if (status.return_assign) {
			status.code += `${status.return_assign} = 0;\n`;
		} else if (status.current_function_name?.toLocaleLowerCase() === "main") {
			// C's main returns int; a bare Nomen `return` (void) lowers to `return 0;`
			status.code += `return 0;\n`;
		} else {
			status.code += `return;\n`;
		}
		return;
	}

	// Array return: C can't return arrays by value. The local stack array
	// (e.g. `struct Box *arr[N]`) must be copied into a heap-allocated
	// Array_<T> buffer (header struct + inline data) and the pointer returned.
	// Determine the array length BEFORE removing the decl from
	// scoped_declarations (we need to read its initializer / type length).
	const ret_type = status.function_return_type || node.type;
	let return_array_len = 0;
	let return_array_var = "";
	if (ret_type?.is_array && node.value.node_type === "array") {
		// Returning an array literal directly (e.g. `return [1, 2, 3]`).
		// C can't return arrays by value, so materialize the literal into a
		// temp stack array; the heap-allocate-and-copy path below then moves
		// it into an Array_<T> buffer and returns the pointer (mirrors how a
		// `var nums = [1, 2, 3]` declaration lowers to `long nums[3]`).
		const arr = node.value as ArrayValuesNode;
		return_array_len = arr.values.length;
		return_array_var = "_return_array";
		const elem_struct = status.structs.find((s) => s.name === ret_type.name && !s.is_simple_type);
		const elem_is_class = !!elem_struct?.is_class;
		const elem_c_type = elem_is_class ? `struct ${ret_type.name}*` : c_type(ret_type.name);
		status.code += `${elem_c_type} ${return_array_var}[${return_array_len}] = `;
		build_array_values_node(arr, status);
		status.code += ";\n";
	} else if (ret_type?.is_array && node.value.node_type === "value") {
		return_array_var = (node.value as ValueNode).value;
		const decl = status.scoped_declarations.find((d) => d.name === return_array_var);
		if (decl?.value?.node_type === "array") {
			return_array_len = (decl.value as ArrayValuesNode).values.length;
		} else if (decl?.type?.length) {
			try {
				return_array_len = parseInt((decl.type.length as unknown as ValueNode).value || "0");
			} catch {
				return_array_len = 0;
			}
		}
	}

	// HACK: This needs more work to map return values to declarations
	// Remove the return value from scoped_declarations so it won't be disposed.
	// Capture the declaration FIRST (searching the whole scope stack, since a
	// return inside an if/while sub-scope may reference a variable declared in
	// an enclosing frame): a later borrow check (returns_borrow_var) needs to
	// know whether the returned variable is an owned local vs. a
	// parameter/borrow, and this splice removes the decl so a subsequent lookup
	// would mis-classify every local return as a parameter. The splice itself
	// only affects the current frame (an outer-frame decl is left for its own
	// scope-exit cleanup, which is dead code after a return anyway).
	let returned_value_decl: DeclarationNode | undefined;
	if (node.value.node_type === "value") {
		const value = (node.value as ValueNode).value;
		returned_value_decl = find_decl_across_scopes(value, status);
		let di = status.scoped_declarations.indexOf(returned_value_decl as DeclarationNode);
		if (di !== -1) {
			status.scoped_declarations.splice(di, 1);
		}
	}

	// Array return path: heap-allocate the Array_<T> buffer, copy the stack
	// array's elements into it, auto-free remaining scope locals, then return.
	if (ret_type?.is_array && return_array_var && return_array_len > 0) {
		const elem_name = ret_type.name;
		const array_struct = `Array_${elem_name}`;
		const elem_struct = status.structs.find((s) => s.name === elem_name && !s.is_simple_type);
		const elem_is_class = !!elem_struct?.is_class;
		const elem_c_type = elem_is_class ? `struct ${elem_name}*` : c_type(elem_name);
		status.code += `struct ${array_struct}* _return_val = malloc(sizeof(struct ${array_struct}) + ${return_array_len} * sizeof(${elem_c_type}));\n`;
		status.code += `_return_val->length = ${return_array_len};\n`;
		status.code += `${elem_c_type}* _return_data = (${elem_c_type}*)((char*)_return_val + sizeof(struct ${array_struct}));\n`;
		status.code += `for (long _i = 0; _i < ${return_array_len}; _i++) _return_data[_i] = ${return_array_var}[_i];\n`;
		build_auto_free(status);
		status.code += `return _return_val;\n`;
		return;
	}

	// Build the return value expression, then auto-free, then return.
	// The return value is stored in a temp so that temporaries used in the
	// expression can be freed before the actual return (otherwise they leak).
	const old_return_assign = status.return_assign;
	if (old_return_assign) {
		emit_allocations(node.value, status);
		status.code += `${old_return_assign} = `;
		build_node(node.value, status);
		status.code += `;\n`;
		build_auto_free(status);
	} else {
		emit_allocations(node.value, status);
		// Use the function's declared return type for the _return_val temp.
		// The expression type (node.type) may differ when type erasure is in
		// play (e.g. List<Animal>.pop returns T=Animal, but the expression
		// `self.items.move_int(idx)` returns int/long from ClassBuffer's
		// type-erased storage). Fall back to node.type if function_return_type
		// is not available.
		const ret_type = status.function_return_type || node.type;
		// Monomorphize generic return types: `List<int>` → `List_int`.
		const mono_ret_name = mono_type_name(ret_type);
		const return_struct = status.structs.find((s) => s.name === mono_ret_name && !s.is_simple_type);
		const is_struct = !!return_struct;
		const return_is_class = !!return_struct?.is_class;
		const return_trait = status.traits.find((t) => t.name === ret_type.name);
		// Class returns are pointers; struct returns are by-value. A `view T`
		// return is the universal nomen_view (ptr, len) struct, by value. A
		// trait-typed return is a pointer to a heap-allocated, vtable-bearing
		// struct (a class instance or a boxed value struct that conforms to
		// the trait) — without the `*`, the bare typedef would be initialised
		// as a value from `0L` or `load_int()`'s long, neither of which is a
		// struct value.
		// An `Array<T>` return type (parse-rewritten to `{name: T, is_array:
		// true}`) is a heap `struct Array_<T>*` pointer when it reaches this
		// fall-through path: the stack-array-to-heap-copy path above already
		// `return`ed for literal / fixed-size-declaration returns, so the only
		// `is_array` cases left are returning an existing heap-array pointer
		// (a variable from `Array.with(...)`, or a call to another
		// `Array<T>`-returning function). Emit the matching pointer type so
		// the `_return_val` temp matches the function signature — without
		// this, the temp falls through to `c_type(elem)` (e.g. `long`), which
		// round-trips on 64-bit but is a type mismatch and breaks 32-bit /
		// generates implicit-conversion warnings.
		const type_prefix = ret_type.is_array
			? `struct Array_${ret_type.name}* `
			: ret_type.is_view
				? "nomen_view "
				: is_struct
					? return_is_class
						? `struct ${mono_ret_name}* `
						: `struct ${mono_ret_name} `
					: return_trait
						? `struct ${ret_type.name}* `
						: c_type(ret_type.name || "int");
		// Match/switch/if are statements in C, not expressions — `_return_val
		// = switch(...)` is invalid. Declare _return_val uninitialised, set
		// return_assign so each branch's LetNode/ReturnNode assigns to it,
		// then return it.
		if (
			node.value.node_type === "match" ||
			node.value.node_type === "switch" ||
			node.value.node_type === "if"
		) {
			status.code += `${type_prefix} _return_val;\n`;
			status.return_assign = "_return_val";
			// Mixed string-join normalization: when ANY branch produces a
			// fresh owned heap string (interpolation/concat/call), strdup the
			// non-owned branch values (literals/borrows) at their assignment so
			// `_return_val` uniformly owns its result — returning it directly.
			// When NO branch is owned, keep the join-point `return strdup(...)`
			// normalization (a literal/borrow result must become an owned heap
			// copy for the caller, which frees every string call result).
			const string_join = ret_type.name === "string" && !ret_type.is_view && !ret_type.is_array;
			const branch_values = collect_expression_branch_values(node.value);
			const any_branch_owned =
				string_join && branch_values.some((v) => is_owned_string_branch_value(v, status));
			const old_join_owned = status.join_needs_owned_string;
			if (any_branch_owned) status.join_needs_owned_string = true;
			build_node(node.value, status);
			status.join_needs_owned_string = old_join_owned;
			status.return_assign = old_return_assign;
			build_auto_free(status);
			if (string_join) {
				status.code += any_branch_owned ? `return _return_val;\n` : `return strdup(_return_val);\n`;
			} else {
				status.code += `return _return_val;\n`;
			}
			return;
		}
		status.code += `${type_prefix} _return_val = `;
		// `return self` from a value method: build_value_node dereferences
		// the `self` pointer uniformly (so `var T c = self` and `return self`
		// both copy the struct), so no special-case `*` is needed here.
		const returns_bare_self = false;
		// A trait-typed return inside a monomorphized container method (e.g.
		// `T List_T_at(...) { return self.items.load_int(i); }`) wraps a raw
		// `long`-returning storage primitive (ClassBuffer.load_int/move_int).
		// The declared return type is `struct <Trait> *`, so cast the int
		// expression to the pointer type. Without this, `struct Speaker *_x =
		// long_expr` is an integer-to-pointer conversion error. Skip when the
		// return type is `view T` — that's the universal nomen_view struct,
		// not a pointer.
		if (return_trait && !ret_type.is_view) {
			status.code += `(struct ${ret_type.name} *)`;
		}
		// A string returned via field access (e.g. `return self.name` or
		// `return a.field`) is a BORROW — the storage belongs to the struct.
		// The C backend's auto_free assumes string returns transfer ownership
		// (the caller frees the result), so strdup the borrow here and bump
		// the audit counter. Without this, the caller's auto_free crashes
		// trying to free a non-heap pointer (e.g. a string literal field).
		// This also covers trait method bodies (`return self.field` inside a
		// trait method), which compile to vtable dispatches that ultimately
		// return borrowed struct fields.
		// Only a FIELD access (`return self.name`) borrows the struct's storage
		// and must be strdup'd. A METHOD call that returns a string (e.g.
		// `return sb.to_string()`, or any owned_return/heap-returning method)
		// already produces a fresh owned heap string — strdup'ing it copies the
		// result and LEAKS the original. Detect the access kind and skip the
		// strdup for owned-string-returning method calls.
		let returns_borrowed_string =
			ret_type.name === "string" && !ret_type.is_view && node.value.node_type === "access";
		// A bare string literal return (`return "Wizard"`) is not heap-allocated;
		// the caller's auto_free would crash freeing it. strdup to make it owned.
		const returns_string_literal =
			ret_type.name === "string" &&
			!ret_type.is_view &&
			node.value.node_type === "value" &&
			(node.value as ValueNode).value.length >= 2 &&
			(node.value as ValueNode).value.startsWith('"') &&
			(node.value as ValueNode).value.endsWith('"');
		// A bare VARIABLE return (`return s`) hands the caller a pointer the
		// callee does not own when the variable is a parameter or a
		// borrow-initialized local (e.g. `const string t = xs.at(0); return t`,
		// or `const string x = "lit"; return x`). The caller's auto_free frees
		// every string call result (see build_auto_free), so a raw borrow
		// crashes (freeing argv/container storage or a static literal). strdup
		// at the return so the caller frees a fresh heap copy. An OWNED local
		// (a heap value the callee would otherwise free at scope exit) is left
		// alone: ownership transfers to the caller when the decl is spliced out
		// of scoped_declarations below, so strdup'ing it would leak the
		// original. A var is a borrow here iff it is NOT a freeable owned
		// local — i.e. it's a parameter (not in scoped_declarations) or it
		// matches the auto_free borrow test (`is_string_borrow(init)` or a
		// recorded `string_borrow_vars` literal).
		let returns_borrow_var = false;
		if (
			ret_type.name === "string" &&
			!ret_type.is_view &&
			node.value.node_type === "value" &&
			!returns_string_literal
		) {
			const var_name = (node.value as ValueNode).value;
			// Use the decl captured before the scoped_declarations splice (the
			// returned value is removed there so it isn't freed at scope exit).
			if (!returned_value_decl) {
				// Not a local declaration → a parameter (or otherwise non-local).
				returns_borrow_var = true;
			} else if (
				is_string_borrow(returned_value_decl.value) ||
				!!status.string_borrow_vars?.has(var_name)
			) {
				returns_borrow_var = true;
			}
		}
		if (returns_borrowed_string) {
			const access = (node.value as AccessNode).access;
			if (access.node_type === "access_func") {
				const fn = access as unknown as {
					name?: string;
					mangled_name?: string;
					owned_return?: boolean;
				};
				const nm = fn.mangled_name || fn.name || "";
				const recv_type = type_from_value_node((node.value as AccessNode).target);
				const recv_name = recv_type?.name;
				// A trait-dispatched method call (`s.speak()` on a trait-typed
				// receiver) routes through the vtable to a conforming method,
				// which on this backend already strdup's its string return. So
				// the dispatched result is a fresh owned heap string — strdup'ing
				// it again leaks the inner copy. Treat it as owned (don't strdup).
				const recv_is_trait = !!recv_name && !!status.traits.find((t) => t.name === recv_name);
				// A concrete method call (`d.speak()`) is owned iff the resolved
				// method strdup's its return — on this backend that is any method
				// with a body whose return type is `string` (every string return
				// is strdup'd). Resolve via the AST (receiver type → struct →
				// method) rather than the heap_returning_functions set, which is
				// not yet populated for methods of structs nested inside a
				// function body (e.g. `main`) at the point this return is built.
				// `to_string` is handled by the dedicated clause below (and
				// `string_to_string` is the identity exception that stays a borrow).
				let concrete_method_owned = false;
				if (recv_name && !recv_is_trait && fn.name && fn.name !== "to_string") {
					let struct_name = recv_name;
					if (recv_type?.type_args?.length) {
						const mono = mono_type_name(recv_type);
						if (status.structs.find((s) => s.name === mono)) struct_name = mono;
					}
					const struct = status.structs.find((s) => s.name === struct_name);
					const m = (struct?.functions ?? []).find((f) => f.name === fn.name);
					if (m && (m as any).has_body && (m as any).return_type?.name === "string") {
						concrete_method_owned = true;
					}
				}
				const returns_owned_string =
					fn.owned_return ||
					(fn.name === "to_string" && nm !== "string_to_string") ||
					nm.startsWith("_string_interpolate_") ||
					recv_is_trait ||
					concrete_method_owned ||
					!!status.heap_returning_functions?.has(nm);
				if (returns_owned_string) returns_borrowed_string = false;
				// A `move_T` call (`owned_return`, e.g. inside `List<string>.pop`'s
				// `return self.items.move_T(idx)`) relinquishes the buffer slot and
				// returns its `char*`. A `Buffer<string>` slot owns an independent
				// heap copy (store_T strdup's), so the returned pointer is already
				// heap — it is handed to the caller as-is (owned_return), no
				// strdup. (When the buffer held shallow borrows, the slot could be
				// rodata and a return-site strdup was required; owning slots make
				// that redundant and a leak.)
				// A container/buffer BORROW accessor (`.at`/`.first`/`.slice` or the
				// backing `load_T`) returns a view into the receiver's storage. This
				// is decisive — it overrides the `concrete_method_owned` conclusion
				// above (which can't tell that `List.at`'s `return self.items.load_T(i)`
				// yields a borrow, not an owned string). When returned from a USER
				// function (receiver is NOT self), the caller frees every string call
				// result, so the borrow must be strdup'd into an owned heap copy;
				// passing the raw borrow through crashes on the caller's free. When
				// the receiver IS self — the accessor method's own body — keep it a
				// borrow: the caller invokes it through `.at`/`.first`, whose result
				// `is_string_borrow` treats as non-owned (not freed), so strdup'ing
				// would hand the caller a heap copy it never frees (a leak). `mov out
				// T` accessors (`owned_return`, e.g. `pop`) relinquish the slot and
				// stay owned.
				const is_container_borrow_accessor =
					!fn.owned_return &&
					(fn.name === "at" || fn.name === "first" || fn.name === "slice" || fn.name === "load_T");
				if (is_container_borrow_accessor) {
					// Only keep the borrow (skip strdup) when building the accessor
					// method's OWN body — the caller invokes `.at`/`.first`, which
					// `is_string_borrow` treats as non-owned (not freed). A different
					// function (e.g. `Map.get`) returning `self.values.load_T(idx)`
					// must strdup: its caller (`.get`) is not a recognized borrow
					// accessor and frees every string call result. The original
					// `access_receiver_is_self` heuristic was too broad — it matched
					// any `self.<field>.load_T(i)` even inside a non-accessor body.
					const fn_name = status.current_function_name;
					returns_borrowed_string = fn_name !== "at" && fn_name !== "first";
				}
			}
		}
		if (returns_borrowed_string || returns_string_literal || returns_borrow_var) {
			status.code += `strdup(`;
		}
		// Type erasure: when the function returns a class/struct pointer but
		// the return expression is a simple type (e.g. long from ClassBuffer's
		// type-erased load_int/move_int), cast the expression to the correct
		// pointer type so C's type system is satisfied.
		const expr_type_name = node.type?.name || "";
		const expr_is_simple = !status.structs.find(
			(s) => s.name === expr_type_name && !s.is_simple_type,
		);
		const needs_type_erasure_cast =
			is_struct &&
			expr_is_simple &&
			!returns_bare_self &&
			!returns_borrowed_string &&
			!ret_type.is_view;
		if (needs_type_erasure_cast) {
			status.code += return_is_class ? `(struct ${mono_ret_name}*)` : `(struct ${mono_ret_name})`;
		}
		build_node(node.value, status);
		if (returns_borrowed_string || returns_string_literal || returns_borrow_var) {
			status.code += `)`;
		}
		status.code += `;\n`;
		// `return T(...) + [ ... ]`: apply the named-field overrides to the
		// _return_val temp before returning it.
		if (
			node.value.node_type === "func_call" &&
			(node.value as FunctionCallNode).field_overrides?.length
		) {
			emit_field_overrides("_return_val", node.value, build_node, status, "", ";\n");
		}
		build_auto_free(status);
		status.code += `return _return_val;\n`;
	}
}

/**
 * Find a declaration by name across the current scope frame and all enclosing
 * frames on the c_scope_stack. A return inside an if/while sub-scope may
 * reference a variable declared in an enclosing scope, which is not in the
 * current `scoped_declarations` (a fresh frame per enter_c_scope).
 */
function find_decl_across_scopes(name: string, status: BuildStatus): DeclarationNode | undefined {
	let decl = status.scoped_declarations.find((d) => d.name === name);
	if (decl) return decl;
	const stack = status.c_scope_stack;
	if (stack) {
		for (let i = stack.length - 1; i >= 0; i--) {
			decl = stack[i].find((d) => d.name === name);
			if (decl) return decl;
		}
	}
	return undefined;
}
