import { mono_type_name } from "../build_common/mono_name.ts";
import { classify_param } from "../build_common/param_classify.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import type BuildStatus from "./BuildStatus.ts";
import array_struct_name from "./utils/array_struct.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";

export default function build_parameter_node(node: ParameterNode, status: BuildStatus) {
	let type_name =
		node.is_self_param && status.current_struct ? status.current_struct.name : node.type.name;
	// HACK: For non-self params of specialized generic structs (e.g. Array_int),
	// replace generic type name (e.g. Array) with the specialized name
	if (
		!node.is_self_param &&
		status.current_struct &&
		type_name !== status.current_struct.name &&
		status.current_struct.name.startsWith(type_name + "_")
	) {
		type_name = status.current_struct.name;
	}
	// An `Array<T>` parameter (parse-rewritten to `{name: T, is_array: true}`)
	// is a heap `struct Array_<T>*` pointer, not a raw element pointer. Promote
	// it to the struct name so the rest of this function (and the body) treats
	// it like any generic struct param. Variadic params (`...T`, also
	// `is_array`) are raw element pointers and stay as-is. Excludes a
	// length-bearing `T[N]` (a fixed-size stack array), which `array_struct_name`
	// already rejects via the `length` guard.
	if (!node.is_self_param && !node.is_variadic) {
		const arr_struct = array_struct_name(node.type, status);
		if (arr_struct) type_name = arr_struct;
	}
	// For free functions (no current_struct) with an explicitly-instantiated
	// generic parameter type (e.g. `Tree<int> tree`), rewrite the type name to
	// its monomorphized form (e.g. `Tree_int`) so the C signature matches the
	// monomorphized struct definition.
	if (!node.is_self_param && node.type.type_args?.length) {
		const mono_name = mono_type_name(type_name, node.type.type_args);
		if (status.structs.find((s) => s.name === mono_name && !s.is_generic)) {
			type_name = mono_name;
		}
	}

	// Function-type parameter: emit a function pointer type so the parameter
	// can be called directly (e.g. `long (*f)(long)` instead of `void *f`,
	// which can't be invoked).
	if (node.func_params || node.func_return_type) {
		const return_type_name = node.func_return_type?.name || "void";
		status.code += `${c_type(return_type_name)} (*${c_function_name(node.name)})(`;
		const params = node.func_params || [];
		for (let i = 0; i < params.length; i++) {
			if (i > 0) {
				status.code += ", ";
			}
			build_parameter_node(params[i], status);
		}
		status.code += `)`;
		return;
	}

	// A `view T` parameter is the universal non-owning (ptr, len) slice
	// struct, passed by value (matching the aarch64 register pair). Inside
	// the body, `.length` lowers to `.len` and the view builtins (.at /
	// .to_string) operate on it directly.
	if (!node.is_self_param && node.type.is_view) {
		status.code += `nomen_view ${c_function_name(node.name)}`;
		return;
	}

	const cls = classify_param(
		node.type,
		type_name,
		{
			is_ref: node.is_ref || node.type.is_ref,
			is_self: node.is_self_param,
			declaration: node.declaration,
		},
		status,
	);
	// A struct/trait parameter uses the `struct Tag *` form: the TAG (plain
	// name) is never mangled, only the typedef is — and a parameter is a
	// pointer to the struct, not a typedef value. Emit the tag directly rather
	// than `c_type`, which would yield the (possibly mangled) typedef.
	if (cls.is_struct) {
		status.code += `struct ${type_name}`;
	} else {
		status.code += c_type(type_name);
	}
	if (cls.is_ref_class) {
		status.code += ` **`;
	} else if (cls.wants_pointer) {
		status.code += ` *`;
	} else {
		status.code += ` `;
	}
	status.code += c_function_name(node.name);
}
