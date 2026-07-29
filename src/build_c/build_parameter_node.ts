import ParameterNode from "../nodes/ParameterNode.ts";
import type BuildStatus from "./BuildStatus.ts";
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
	// For free functions (no current_struct) with an explicitly-instantiated
	// generic parameter type (e.g. `Tree<int> tree`), rewrite the type name to
	// its monomorphized form (e.g. `Tree_int`) so the C signature matches the
	// monomorphized struct definition.
	if (!node.is_self_param && node.type.type_args?.length) {
		const mono_name = `${type_name}_${node.type.type_args.map((t) => t.name).join("_")}`;
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

	const struct_type = status.structs.find((s) => s.name === type_name);
	const trait_type = status.traits.find((t) => t.name === type_name);
	const is_struct =
		(node.is_self_param || struct_type || trait_type) && !struct_type?.is_simple_type;
	// A struct/trait parameter uses the `struct Tag *` form: the TAG (plain
	// name) is never mangled, only the typedef is — and a parameter is a
	// pointer to the struct, not a typedef value. Emit the tag directly rather
	// than `c_type`, which would yield the (possibly mangled) typedef.
	if (is_struct) {
		status.code += `struct ${type_name}`;
	} else {
		status.code += c_type(type_name);
	}
	// Pointer rules:
	//   - struct / trait params: always `struct T *` (by reference)
	//   - `ref` / array params: pass by pointer (modifications propagate)
	//   - `mov` on a SIMPLE type is by-value (the parser normalizes mov to
	//     var+is_moved; for simple types that pointer is meaningless, so skip it)
	//   - `var` on a SIMPLE type is by-value too: the callee gets a mutable
	//     local copy. Modifying it does not propagate to the caller (the
	//     `ref` keyword is used for pass-by-reference).
	const is_simple = !!struct_type?.is_simple_type;
	const wants_pointer =
		is_struct ||
		!!trait_type ||
		node.is_ref ||
		node.type.is_ref ||
		node.type.is_array ||
		(!is_simple && node.declaration === "var");
	// A `ref` CLASS param is a double pointer (`struct T **`): the call site
	// passes the address of the caller's pointer slot so the callee can
	// reassign the caller's variable (write-back) and reclaim the old instance.
	// Mirrors the aarch64 backend's ref_class_slots. Regular class params stay
	// single pointers.
	const is_ref_class =
		(node.is_ref || node.type.is_ref) && !!struct_type?.is_class && !node.is_self_param;
	if (is_ref_class) {
		status.code += ` **`;
	} else if (wants_pointer) {
		status.code += ` *`;
	} else {
		status.code += ` `;
	}
	status.code += c_function_name(node.name);
}
