import CastNode from "../nodes/CastNode.ts";
import { pointer_element_c_type } from "./build_index_node.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_cast_node(node: CastNode, status: BuildStatus) {
	// If the cast has an operator function (#op_as), emit a function call
	if (node.operator_func) {
		const { struct_name, func_name, mangled_name } = node.operator_func;
		const call_name = mangled_name || `${struct_name}_${c_function_name(func_name)}`;
		const source_type = type_from_value_node(node.value).name;
		const source_struct = status.structs.find((s) => s.name === source_type && !s.is_simple_type);
		status.code += `${call_name}(`;
		if (source_struct) {
			status.code += `&`;
		}
		build_node(node.value, status);
		status.code += `)`;
		return;
	}

	// `unsafe` pointer casts (checker-gated): integer ↔ `ptr T`, and
	// `string` → `ptr char` (the fat value's data pointer).
	const value_type = type_from_value_node(node.value);
	if (node.target_type.is_pointer || value_type.is_pointer) {
		if (node.target_type.is_pointer) {
			status.code += `(${pointer_element_c_type(node.target_type, status)}*)`;
			if (value_type.name === "string" && !value_type.is_pointer) {
				// Fat string → its backing bytes: the thin pointer inside the
				// nomen_string value (or behind the ref-self pointer — the
				// natural `*self` deref comes from build_value_node).
				status.code += `(`;
				build_node(node.value, status);
				status.code += `).ptr`;
				return;
			}
			build_node(node.value, status);
			return;
		}
		// Pointer → integer: same bits, reinterpreted. A struct/class pointer
		// (`self as uint64`) must emit the POINTER (`self`), not a deref'd
		// struct lvalue — suppress the value-node deref.
		status.code += `(${c_type(node.target_type.name)})`;
		status.suppress_dereference = true;
		build_node(node.value, status);
		status.suppress_dereference = false;
		return;
	}

	const is_struct = !!status.structs.find(
		(s) => s.name === node.target_type.name && !s.is_simple_type,
	);
	const prefix = is_struct ? "struct " : "";

	// Casting a literal zero to a value struct (e.g. the core library's
	// generic `return 0` zero-value in Map.get with TV = struct): emit a
	// zero-initialized compound literal instead of an int cast — C rejects
	// `(struct X)0`.
	if (is_struct && !node.target_type.is_ref) {
		const value = node.value;
		if (value.node_type === "value" && (value as { value?: string }).value === "0") {
			status.code += `(${prefix}${c_type(node.target_type.name)}){0}`;
			return;
		}
	}

	status.code += `(${prefix}${c_type(node.target_type.name)})`;
	build_node(node.value, status);
}
