import type { NirStmt } from "../nir/nir.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import {
	enter_c_scope,
	leave_c_scope,
	pop_c_loop_frame,
	push_c_loop_frame,
} from "./utils/c_scope.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_for_loop_node(
	node: ForLoopNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "for" },
) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = enter_c_scope(status);
	const old_deferred_frees = status.deferred_frees;
	status.deferred_frees = [];
	push_c_loop_frame(status);

	let ref_writeback: (() => void) | undefined;
	// A call-returned list (`for v of triple()`) materializes into a heap
	// `struct Array_<T>*` temp; the decl is registered in the ENCLOSING scope
	// frame (never the loop frame — break/continue reclaim that frame's decls
	// before jumping, and the loop condition re-reads `->length`).
	let materialized_list_decl: DeclarationNode | undefined;

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
			let is_heap = !!list_name && !!status.heap_array_vars?.has(list_name);
			// A call-returned array (`for v of triple()`) has no compile-time
			// length: the `build_node(list_type.length!)` header read used to
			// crash the build. Materialize the call ONCE into a heap temp —
			// re-evaluating the expression in the loop header would otherwise
			// re-invoke the call on every condition check and element load —
			// register it in heap_array_vars, and iterate the temp via the
			// existing heap path. The temp's declaration joins the ENCLOSING
			// scope frame so break/continue (which reclaim the loop frame)
			// never free it out from under the loop condition, while the
			// normal scope-exit and return paths do.
			const list_is_call =
				node.list.node_type === "func_call" ||
				(node.list.node_type === "access" &&
					(node.list as any).access?.node_type === "access_func");
			let temp_list: string | undefined;
			if (!is_heap && !list_type.length && list_is_call) {
				const id = (status.label_counter = (status.label_counter ?? 0) + 1);
				temp_list = `_list_${id}`;
				status.code += `struct Array_${element_type}* ${temp_list} = `;
				build_node(node.list!, status);
				status.code += `;\n`;
				if (!status.heap_array_vars) status.heap_array_vars = new Set();
				status.heap_array_vars.add(temp_list);
				const decl = new DeclarationNode(
					node.list.start,
					"private",
					"const",
					temp_list,
					list_type,
					node.list,
				);
				const stack = status.c_scope_stack;
				if (stack && stack.length >= 2) {
					stack[stack.length - 2].push(decl);
				} else {
					old_scoped_declarations.push(decl);
				}
				materialized_list_decl = decl;
				is_heap = true;
			}
			// The temp's C text is already emitted; re-building the list node
			// would re-invoke the call.
			const emit_list_ref = () => {
				if (temp_list) {
					status.code += temp_list;
				} else {
					build_node(node.list!, status);
				}
			};
			status.code += `for (int ${idx_var} = 0; ${idx_var} < `;
			if (is_heap) {
				emit_list_ref();
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
				emit_list_ref();
				status.code += ` + sizeof(struct Array_${element_type})))[${idx_var}];\n`;
			} else {
				emit_list_ref();
				status.code += `[${idx_var}];\n`;
			}

			// For `for ref x of arr`, build the write-back snippet that persists
			// the (possibly mutated) loop variable back into its array slot.
			// Emitted after the body and before break/continue.
			if (node.item_is_ref) {
				let wb_target: string;
				if (is_heap) {
					const ref_name = temp_list ?? list_name;
					const elem_ptr = elem_is_class
						? `struct ${element_type} **`
						: `${elem_struct ? `struct ${element_type}` : c_type(element_type)} *`;
					wb_target = `((${elem_ptr})((char *)${ref_name} + sizeof(struct Array_${element_type})))[${idx_var}]`;
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

	build_block_with_cursor(node, nir?.body, status);

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
