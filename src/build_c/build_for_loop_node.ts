import ForLoopNode from "../nodes/ForLoopNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import {
	enter_c_scope,
	leave_c_scope,
	pop_c_loop_frame,
	push_c_loop_frame,
} from "./utils/c_scope.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_for_loop_node(node: ForLoopNode, status: BuildStatus) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = enter_c_scope(status);
	const old_deferred_frees = status.deferred_frees;
	status.deferred_frees = [];
	push_c_loop_frame(status);

	let ref_writeback: (() => void) | undefined;

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
			const elem_is_class = !!elem_struct?.is_class;
			if (elem_is_class) {
				status.code += `struct ${element_type} *${node.item.value} = `;
				if (!status.class_vars) status.class_vars = new Set();
				status.class_vars.add(node.item.value);
			} else if (elem_struct) {
				status.code += `struct ${element_type} ${node.item.value} = `;
			} else {
				status.code += `${c_type(element_type)} ${node.item.value} = `;
			}
			if (is_heap) {
				// Data lives just past the Array_<T> header: index into it.
				// Class elements are stored as pointers (struct T **); struct
				// and primitive elements are stored by-value (T *).
				const elem_ptr = elem_is_class
					? `struct ${element_type} **`
					: `${elem_struct ? `struct ${element_type}` : c_type(element_type)} *`;
				status.code += `((${elem_ptr})((char *)`;
				build_node(node.list!, status);
				status.code += ` + sizeof(struct Array_${element_type})))[${idx_var}];\n`;
			} else {
				build_node(node.list!, status);
				status.code += `[${idx_var}];\n`;
			}

			// For `for ref x of arr`, build the write-back snippet that persists
			// the (possibly mutated) loop variable back into its array slot.
			// Emitted after the body and before break/continue.
			if (node.item_is_ref) {
				let wb_target: string;
				if (is_heap) {
					const elem_ptr = elem_is_class
						? `struct ${element_type} **`
						: `${elem_struct ? `struct ${element_type}` : c_type(element_type)} *`;
					wb_target = `((${elem_ptr})((char *)${list_name} + sizeof(struct Array_${element_type})))[${idx_var}]`;
				} else {
					wb_target = `${list_name}[${idx_var}]`;
				}
				const wb_code = `${wb_target} = ${node.item.value};\n`;
				ref_writeback = () => {
					status.code += wb_code;
				};
			}
		}
	}

	// Push the ref write-back so break/continue emit it before jumping.
	if (!status.loop_writebacks) status.loop_writebacks = [];
	status.loop_writebacks.push(ref_writeback);

	build_block_node(node, status);

	// Emit the update expression at the end of each iteration
	if (node.update) {
		build_node(node.update, status);
		status.code += ";\n";
	}

	// Write the (possibly mutated) loop variable back into its array slot.
	if (ref_writeback) ref_writeback();

	build_auto_free(status);

	status.code += `}\n`;

	status.loop_writebacks.pop();

	// Close the wrapping block for range/enumerable for-loops (scoping the
	// loop variable to prevent redefinition).
	if (node.list && (node.list.node_type == "range" || is_enumerable_type(node.list, status))) {
		status.code += `}\n`;
	}

	pop_c_loop_frame(status);
	leave_c_scope(status);
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
