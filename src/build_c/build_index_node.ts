import { mono_type_name } from "../build_common/mono_name.ts";
import IndexNode from "../nodes/IndexNode.ts";
import type Type from "../nodes/Type.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

/**
 * The C type of one element behind a `ptr T`: the same element
 * representation the raw-block `T` substitution uses (fat `nomen_string`
 * for strings, tagged structs for value structs, `struct T*` handles for
 * classes) so pointer indexing always agrees with raw-block slab layout.
 */
export function pointer_element_c_type(elem: Type, status: BuildStatus): string {
	const name = elem.name;
	const struct = status.structs.find((s) => s.name === name && !s.is_simple_type);
	if (name === "string") return "nomen_string";
	if (struct?.is_class) return `struct ${name} *`;
	if (struct) return `struct ${name}`;
	return c_type(name);
}

/**
 * `p[index]` (rvalue) — a typed load through a raw pointer:
 * `((T*)p)[index]`. The C compiler owns the element-width question (it
 * knows `sizeof(T)`); the aarch64 backend hand-writes the equivalent
 * width dispatch. Only reached inside `unsafe` code — the checker
 * rejected everything else.
 */
export default function build_index_node(node: IndexNode, status: BuildStatus) {
	const elem = node.type ?? type_from_value_node(node.target);
	// An Array receiver's elements start after the struct header on C
	// (`(T*)((char*)self + sizeof(*self))`). The mono struct name comes from
	// the receiver: the enclosing Array_* method's `self`, or the resolved
	// heap-array type.
	if (node.is_array_target) {
		let mono = "";
		if (node.target.node_type === "value" && status.current_struct) {
			mono = status.current_struct.name;
		}
		if (!mono || !mono.startsWith("Array_")) {
			const t = type_from_value_node(node.target);
			mono = mono_type_name(t);
		}
		status.code += `((${pointer_element_c_type(elem, status)}*)((char*)`;
		status.suppress_dereference = true;
		build_node(node.target, status);
		status.suppress_dereference = false;
		status.code += ` + sizeof(struct ${mono})))[`;
		build_node(node.index, status);
		status.code += `]`;
		return;
	}
	status.code += `((${pointer_element_c_type(elem, status)}*)`;
	build_node(node.target, status);
	status.code += `)[`;
	build_node(node.index, status);
	status.code += `]`;
}
