import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";
import emit_allocations from "./utils/emit_allocations.ts";

export default function build_return_node(node: ReturnNode, status: BuildStatus) {
	if (!node.value) {
		build_auto_free(status);
		if (status.return_assign) {
			status.code += `${status.return_assign} = 0;\n`;
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
	if (ret_type?.is_array && node.value.node_type === "value") {
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
	// Remove the return value from scoped_declarations so it won't be disposed
	if (node.value.node_type === "value") {
		let value = (node.value as ValueNode).value;
		let di = status.scoped_declarations.findIndex((d) => d.name === value);
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
		status.code += `malloc_count++;\n`;
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
		const mono_type_name = ret_type.type_args?.length
			? `${ret_type.name}_${ret_type.type_args.map((t) => t.name).join("_")}`
			: ret_type.name;
		const return_struct = status.structs.find(
			(s) => s.name === mono_type_name && !s.is_simple_type,
		);
		const is_struct = !!return_struct;
		const return_is_class = !!return_struct?.is_class;
		// Class returns are pointers; struct returns are by-value.
		const type_prefix = is_struct
			? return_is_class
				? `struct ${mono_type_name}* `
				: `struct ${mono_type_name} `
			: c_type(ret_type.name || "int");
		status.code += `${type_prefix} _return_val = `;
		// `return self` where self is a pointer param (any non-local self):
		// dereference the pointer so the by-value return copies the struct.
		// Custom #init's self is a local by-value variable, so no deref.
		// Class returns don't deref — the class pointer IS the return value.
		const returns_bare_self =
			node.value.node_type === "value" &&
			(node.value as ValueNode).value === "self" &&
			!status.self_is_local &&
			is_struct &&
			!return_is_class;
		if (returns_bare_self) {
			status.code += `*`;
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
		const returns_borrowed_string = ret_type.name === "string" && node.value.node_type === "access";
		if (returns_borrowed_string) {
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
			is_struct && expr_is_simple && !returns_bare_self && !returns_borrowed_string;
		if (needs_type_erasure_cast) {
			status.code += return_is_class ? `(struct ${mono_type_name}*)` : `(struct ${mono_type_name})`;
		}
		build_node(node.value, status);
		if (returns_borrowed_string) {
			status.code += `); malloc_count++`;
		}
		status.code += `;\n`;
		build_auto_free(status);
		status.code += `return _return_val;\n`;
	}
}
