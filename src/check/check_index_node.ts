import add_error from "../add_error.ts";
import IndexNode from "../nodes/IndexNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import type_name from "./utils/type_name.ts";

/**
 * `p[index]` — the raw-pointer element access of `unsafe` code.
 *
 * The target must be a `ptr T` value; the node takes T's type. As an
 * assignment target (`p[i] = v`) the checker sees the same node via
 * check_assignment_node (which types the target through
 * type_from_value_node → this node's stamped `type`).
 */
export default function check_index_node(node: IndexNode, status: CheckStatus): boolean {
	if (!status.in_unsafe) {
		add_error(
			status,
			`Pointer indexing requires an unsafe context — wrap it in an 'unsafe' block or an 'unsafe func'`,
			node.start,
		);
	}

	check_node(node.target, status);
	check_node(node.index, status);

	const target_type = type_from_value_node(node.target, status);

	// Array indexing: `arr[i]` on a heap `Array<T>` receiver inside unsafe
	// code (the Array methods themselves). The element base is the Array
	// struct's inline storage — each backend owns the header-skip.
	const self_target =
		node.target.node_type === "value" && (node.target as ValueNode).value === "self";
	let array_elem_name: string | undefined;
	if (target_type?.is_array && target_type.is_array_heap) {
		array_elem_name = target_type.name;
	} else if (self_target) {
		// Inside the generic Array<T>'s methods, `self`'s declared type is the
		// bare generic struct ("Array" — no is_array flags) and the element
		// is the struct's type param.
		const self_decl = status.values.findLast((v) => v.name === "self");
		if (self_decl?.type.name === "Array") array_elem_name = status.type_params[0];
	}

	if (!target_type?.is_pointer && !array_elem_name) {
		add_error(
			status,
			`Cannot index ${type_name(target_type)}: only a 'ptr T' value or an Array can be indexed (in unsafe code)`,
			node.start,
		);
		return false;
	}

	if (array_elem_name) {
		node.is_array_target = true;
		node.type = new Type(array_elem_name);
	} else {
		node.type = new Type(target_type.name);
	}
	node.type.start = target_type.start;
	const index_type = type_from_value_node(node.index, status);
	if (index_type.name && !is_integerish(index_type.name)) {
		add_error(
			status,
			`Pointer index must be an integer, not ${type_name(index_type)}`,
			node.index.start,
		);
	}
	return true;
}

function is_integerish(name: string): boolean {
	return (
		name === "int" ||
		name === "uint" ||
		name === "int8" ||
		name === "int16" ||
		name === "int32" ||
		name === "int64" ||
		name === "uint8" ||
		name === "uint16" ||
		name === "uint32" ||
		name === "uint64"
	);
}
