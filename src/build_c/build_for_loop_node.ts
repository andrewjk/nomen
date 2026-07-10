import ForLoopNode from "../nodes/ForLoopNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_for_loop_node(node: ForLoopNode, status: BuildStatus) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = [];
	const old_deferred_frees = status.deferred_frees;
	status.deferred_frees = [];

	if (node.item && node.list) {
		if (node.list.node_type == "range") {
			// Wrap in a block so the loop variable is scoped to this loop,
			// preventing redefinition when multiple for-loops use the same
			// variable name in the same scope.
			status.code += "{\n";
			status.code += `${c_type("int")} `;
			build_node(node.item, status);
			status.code += ";\nfor (";
			build_node(node.item, status);
			status.code += " = ";
			const range = node.list as RangeNode;
			if (range.left_value) {
				build_node(range.left_value, status);
			}
			status.code += "; ";
			build_node(node.item, status);
			status.code += " < ";
			if (range.right_value) {
				build_node(range.right_value, status);
			}
			status.code += "; ";
			build_node(node.item, status);
			status.code += "++)\n{\n";
		} else if (is_enumerable_type(node.list, status)) {
			// Enumerable type: call .length() and iterate 0..length
			status.code += "{\n";
			status.code += `${c_type("int")} `;
			build_node(node.item, status);
			status.code += ";\nfor (";
			build_node(node.item, status);
			status.code += " = 0; ";
			build_node(node.item, status);
			status.code += " < ";
			build_node(node.list, status);
			status.code += `.length(); `;
			build_node(node.item, status);
			status.code += "++)\n{\n";
		} else if (status.traits.find((t) => t.name === node.item.type.name) !== undefined) {
			// TODO: Handle index iterator variable
			const length = type_from_value_node(node.list).length;
			status.code += `for (int i = 0; i < `;
			build_node(length!, status);
			status.code += `; i++)\n{\n`;
			status.code += `void *${node.item.value} = *(`;
			build_node(node.list!, status);
			status.code += " + i);\n";
		} else {
			const list_type = type_from_value_node(node.list);
			const element_type = list_type.name || "int";
			const idx_var = `_idx_${node.item.value}`;
			// Heap-allocated arrays (e.g. from Array.with with a runtime count)
			// have no compile-time length — read it from the Array_<T> header's
			// `length` field, and index into the data region past the header.
			const list_name = node.list!.node_type === "value" ? (node.list as any).value : undefined;
			const is_heap = !!list_name && !!status.heap_array_vars?.has(list_name);
			status.code += `for (int ${idx_var} = 0; ${idx_var} < `;
			if (is_heap) {
				build_node(node.list!, status);
				status.code += `->length`;
			} else {
				build_node(list_type.length!, status);
			}
			status.code += `; ${idx_var}++)\n{\n`;
			// Class-typed elements are pointers — emit `struct T *item`
			// instead of `T item` (which would be a by-value struct).
			const elem_struct = status.structs.find((s) => s.name === element_type && !s.is_simple_type);
			if (elem_struct) {
				status.code += `struct ${element_type} *${node.item.value} = `;
				if (elem_struct.is_class) {
					if (!status.class_vars) status.class_vars = new Set();
					status.class_vars.add(node.item.value);
				}
			} else {
				status.code += `${c_type(element_type)} ${node.item.value} = `;
			}
			if (is_heap) {
				// Data lives just past the Array_<T> header: index into it.
				const elem_ptr = elem_struct ? `struct ${element_type} **` : `${c_type(element_type)} *`;
				status.code += `((${elem_ptr})((char *)`;
				build_node(node.list!, status);
				status.code += ` + sizeof(struct Array_${element_type})))[${idx_var}];\n`;
			} else {
				build_node(node.list!, status);
				status.code += `[${idx_var}];\n`;
			}
		}
	}

	build_block_node(node, status);

	// Emit the update expression at the end of each iteration
	if (node.update) {
		build_node(node.update, status);
		status.code += ";\n";
	}

	build_auto_free(status);

	status.code += `}\n`;

	// Close the wrapping block for range/enumerable for-loops (scoping the
	// loop variable to prevent redefinition).
	if (node.list && (node.list.node_type == "range" || is_enumerable_type(node.list, status))) {
		status.code += `}\n`;
	}

	status.scoped_declarations = old_scoped_declarations;
	status.deferred_frees = old_deferred_frees;
}

function is_enumerable_type(node: any, status: BuildStatus): boolean {
	if (node.node_type !== "value") return false;
	const type_name = node.value;
	const struct = status.structs.find((s) => s.name === type_name);
	if (!struct) return false;
	return struct.traits.includes("Enumerable");
}
