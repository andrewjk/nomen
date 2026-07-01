import type BuildStatus from "../build_c/BuildStatus.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_array_values_node, { resolve_static_value } from "./build_array_values_node.ts";
import build_node from "./build_node.ts";
import build_range_node from "./build_range_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import aarch64_type from "./utils/aarch64_type.ts";
import { emit_strdup, emit_malloc } from "./utils/audit.ts";
import {
	anchor_heap_pointer,
	mark_heap_string,
	mark_moved_if_struct,
	track_struct_decl,
	has_struct_fields_with_destroy,
} from "./utils/auto_destroy.ts";
import { build_swap_params } from "./utils/build_swap.ts";
import {
	allocate_stack_space,
	emit_deref_var_address,
	emit_var_address,
	emit_var_load,
	emit_var_store,
	is_local_ref_var,
} from "./utils/stack_var.ts";
import {
	emit_struct_copy,
	get_enum_size,
	get_field_offset,
	get_struct_size,
} from "./utils/struct_layout.ts";

/**
 * Pass a struct-typed param by address. For ValueNode (variable references)
 * we emit the variable's address; for inline struct constructors we build
 * them and rely on the constructor leaving the address in x0.
 */
// Load an integer literal into x0. aarch64 `mov` (movz) only encodes unsigned
// 16-bit immediates (and movn for small negatives), so larger magnitudes must
// use a `ldr =imm` literal pool load.
function emit_int_immediate(status: BuildStatus, raw: string) {
	const num = parseInt(raw, 10);
	if (!isNaN(num) && num >= 0 && num <= 65535) {
		status.code += `mov x0, #${raw}\n`;
	} else if (!isNaN(num) && num < 0 && num >= -65536) {
		status.code += `movn x0, #${-num - 1}\n`;
	} else {
		status.code += `ldr x0, =${raw}\n`;
	}
}

function emit_struct_address_param(node: BaseNode, status: BuildStatus) {
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		const paramReg = status.function_param_regs?.get(name);
		if (paramReg) {
			if (paramReg !== "x0") {
				status.code += `mov x0, ${paramReg}\n`;
			}
		} else if (is_local_ref_var(name, status)) {
			emit_deref_var_address(status, "x0", name);
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(node, status);
	}
}

function escape_asciz(value: string): string {
	if (!value.includes("\n")) return value;
	const quote = value[0];
	const content = value.slice(1, value.endsWith(quote) ? -1 : undefined);
	return quote + content.replace(/\n/g, "\\n") + (value.endsWith(quote) ? quote : "");
}

/** Allocate an array on the stack with an 8-byte length prefix.
 *  Writes the length at the start and returns the offset of the first element. */
function alloc_array_with_prefix(
	status: BuildStatus,
	length: number,
	element_size: number,
): number {
	const total_size = 8 + length * element_size;
	const start = allocate_stack_space(status, total_size, element_size);
	status.code += `mov x0, #${length}\n`;
	status.code += `str x0, [x29, #${start}]\n`;
	return start + 8;
}

let string_array_counter = 0;

const CONTAINER_BUFFER_FIELDS: Record<string, string> = {
	List: "items",
	LinkedList: "values",
	Tree: "values",
	Graph: "values",
};

/**
 * If `type_name` is a monomorphized generic container (List_X, LinkedList_X,
 * etc.) whose element type is a class, return the name of the Buffer field
 * that stores class pointers (e.g. "items" for List, "values" for LinkedList)
 * along with the element class name. Otherwise return undefined.
 */
export function get_container_class_buffer_field(
	type_name: string,
	status: BuildStatus,
): { field: string; elem: string } | undefined {
	for (const [prefix, buffer_field] of Object.entries(CONTAINER_BUFFER_FIELDS)) {
		if (type_name === prefix || !type_name.startsWith(prefix + "_")) continue;
		const elem_name = type_name.slice(prefix.length + 1);
		const elem_struct = status.structs.find((s) => s.name === elem_name && s.is_class);
		if (elem_struct) return { field: buffer_field, elem: elem_name };
	}
	return undefined;
}

/**
 * Mark a container's values/items buffer so Buffer#destroy reclaims stored
 * class elements. `var_offset` is the stack offset of the container struct.
 * `struct_type_name` is the monomorphized container type name (e.g. "List_Animal").
 * `buffer_field` is the field name ("items" or "values"). `elem_type` is the
 * element class name, used to wire up the per-element destroy callback.
 */
export function emit_set_container_class_refs_for_type(
	status: BuildStatus,
	var_offset: number,
	struct_type_name: string,
	buffer_field: string,
	elem_type: string,
) {
	const buf_offset = get_field_offset(struct_type_name, buffer_field, status);
	// has_class_refs is at offset 24 within Buffer (header:8 + data:8 + cap:8)
	status.code += `add x0, x29, #${var_offset}\n`;
	status.code += `add x0, x0, #${buf_offset}\n`;
	status.code += `mov x1, #1\n`;
	status.code += `str x1, [x0, #24]\n`;
	// destroy_fn at offset 32 -> <elem>_destroy, so Buffer#destroy runs the
	// element's full cleanup (user #destroy + owned-field destroys) before free.
	status.code += `adr x1, ${elem_type}_destroy\n`;
	status.code += `str x1, [x0, #32]\n`;
}

function emit_string_array_labels(values: BaseNode[], status: BuildStatus): Map<string, string> {
	const labels = new Map<string, string>();
	values.forEach((value) => {
		const resolved = resolve_static_value(value, status);
		if (resolved !== null && resolved.startsWith('"')) {
			const label = `_str_arr_${string_array_counter++}`;
			emit_data(status, `${label}: .asciz ${escape_asciz(resolved)}\n.p2align 2\n`);
			labels.set(resolved, label);
		}
	});
	return labels;
}

function needs_runtime_array_init(values: BaseNode[], status: BuildStatus): boolean {
	return values.some((value) => {
		const resolved = resolve_static_value(value, status);
		return resolved !== null && resolved.startsWith('"');
	});
}

function resolve_array_element(raw: string, labels: Map<string, string>): string {
	if (raw.startsWith('"') && labels.has(raw)) {
		return labels.get(raw)!;
	}
	return raw;
}

function get_raw_value(node: ValueNode, status?: BuildStatus): string {
	let val = node.value;
	if (val === "true") return "1";
	if (val === "false") return "0";
	if (val.startsWith("'") && val.endsWith("'") && val.length === 3) {
		return val.charCodeAt(1).toString();
	}
	if (node.is_enum_shorthand && status) {
		const enum_node = status.enums.find((e) => val.startsWith(e.name + "_"));
		if (enum_node) {
			const case_name = val.substring(enum_node.name.length + 1);
			const case_index = enum_node.cases.findIndex((c) => c.name === case_name);
			if (case_index >= 0) return String(case_index);
		}
	}
	if (val.startsWith("0x") || val.startsWith("0X"))
		return String(parseInt(val.replace(/_/g, ""), 16));
	if (val.startsWith("0o") || val.startsWith("0O"))
		return String(parseInt(val.replace(/_/g, ""), 8));
	if (val.startsWith("0b") || val.startsWith("0B"))
		return String(parseInt(val.replace(/_/g, ""), 2));
	return val;
}

function emit_data(status: BuildStatus, data: string) {
	if (status.function_return_label) {
		if (!status.function_data) status.function_data = "";
		status.function_data += data;
	} else {
		status.code += data;
	}
}

function is_struct_constructor(node: BaseNode, status: BuildStatus): boolean {
	if (node.node_type !== "func_call") return false;
	const fc = node as FunctionCallNode;
	return !!status.structs.find((s) => s.name === fc.name && !s.is_simple_type);
}

function is_class_constructor(node: BaseNode, status: BuildStatus): boolean {
	if (node.node_type !== "func_call") return false;
	const fc = node as FunctionCallNode;
	const s = status.structs.find((s) => s.name === fc.name && !s.is_simple_type);
	return !!s && !!s.is_class;
}

function emit_class_constructor_to_slot(
	fc: FunctionCallNode,
	slot_offset: number,
	status: BuildStatus,
	arr_name: string,
) {
	const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
	const struct_size = get_struct_size(fc.name, status);
	status.code += `mov x0, #${struct_size}\n`;
	emit_malloc(status);
	status.code += `str x0, [x29, #${slot_offset}]\n`;
	anchor_heap_pointer(status, `${arr_name}_elem_${slot_offset}`);
	for (let i = fc.params.length - 1; i >= 0; i--) {
		build_node(fc.params[i], status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		status.code += `mov ${param_regs[i]}, x0\n`;
	}
	status.code += `ldr x0, [x29, #${slot_offset}]\n`;
	status.code += `bl ${fc.name}_init\n`;
}

function emit_struct_constructor_to_slot(
	fc: FunctionCallNode,
	slot_addr: string,
	status: BuildStatus,
) {
	const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
	for (let i = fc.params.length - 1; i >= 0; i--) {
		build_node(fc.params[i], status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		status.code += `mov ${param_regs[i]}, x0\n`;
	}
	status.code += slot_addr;
	status.code += `bl ${fc.name}_init\n`;
}

function emit_global_slot_addr(status: BuildStatus, name: string, offset: number) {
	if (offset === 0) {
		status.code += `adr x0, ${name}\n`;
	} else {
		status.code += `adr x0, ${name}\n`;
		status.code += `add x0, x0, #${offset}\n`;
	}
}

function emit_stack_slot_addr(offset: number): string {
	if (offset === 0) {
		return `add x0, x29, #0\n`;
	}
	return `add x0, x29, #${offset}\n`;
}

function has_complex_elements(values: BaseNode[], status: BuildStatus): boolean {
	return values.some((v) => resolve_static_value(v, status) === null);
}

function resolve_array_values(node: any, status: BuildStatus): string[] | null {
	if (node.node_type === "array") {
		return (node as ArrayValuesNode).values
			.map((v) => resolve_static_value(v, status))
			.filter((v): v is string => v !== null);
	}
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		const decl = status.scoped_declarations.find((d) => d.name === name);
		if (decl && decl.value) return resolve_array_values(decl.value, status);
	}
	if (node.node_type === "op") {
		const op = node as OperationNode;
		if (op.operator_func && op.type.is_array) {
			const left_vals = resolve_array_values(op.left_value, status);
			const right_vals = resolve_array_values(op.right_value, status);
			if (left_vals && op.op === "+") {
				const right_all = right_vals || [];
				return [...left_vals, ...right_all];
			}
			if (left_vals && op.op === "*" && op.right_value.node_type === "value") {
				const multiplier = parseInt((op.right_value as ValueNode).value);
				const result: string[] = [];
				for (let i = 0; i < multiplier; i++) result.push(...left_vals);
				return result;
			}
		}
	}
	return null;
}

function resolve_string_value(node: any, status: BuildStatus): string | null {
	if (node.node_type === "value") {
		const val = (node as ValueNode).value;
		if (val.startsWith('"') && val.endsWith('"')) return val;
		const decl = status.scoped_declarations.find((d) => d.name === val);
		if (decl && decl.value) return resolve_string_value(decl.value, status);
	}
	if (node.node_type === "op" && node.type?.name === "string") {
		return resolve_string_op(node, status);
	}
	return null;
}

function strip_quotes(s: string): string {
	return s.slice(1, -1);
}

function resolve_string_op(op: OperationNode, status: BuildStatus): string | null {
	const left = resolve_string_value(op.left_value, status);
	if (!left) return null;
	const left_content = strip_quotes(left);

	if (op.op === "+") {
		const right = resolve_string_value(op.right_value, status);
		if (!right) return null;
		const right_content = strip_quotes(right);
		return `"${left_content}${right_content}"`;
	}

	if (op.op === "*") {
		if (op.right_value.node_type === "value") {
			const multiplier = parseInt((op.right_value as ValueNode).value);
			if (isNaN(multiplier)) return null;
			return `"${left_content.repeat(multiplier)}"`;
		}
	}

	return null;
}

export default function build_declaration_node(node: DeclarationNode, status: BuildStatus) {
	status.last_result_is_heap = false;
	const prev_heap = status.last_result_is_heap;

	function check_heap() {
		if (status.last_result_is_heap) {
			if (node.type.name === "string" && !node.type.is_array) {
				mark_heap_string(status, node.name);
			} else if (node.type.name === "string" && node.type.is_array) {
				const len = node.type.length ? parseInt((node.type.length as ValueNode).value || "0") : 0;
				if (len > 0) {
					if (!status.heap_string_arrays) status.heap_string_arrays = new Map();
					status.heap_string_arrays.set(node.name, len);
					if (status.heap_cleanup_stack?.length) {
						status.heap_cleanup_stack[status.heap_cleanup_stack.length - 1].heap_strings.add(
							node.name,
						);
					}
				}
			} else {
				const struct_type = status.structs.find((s) => s.name === node.type.name && s.is_class);
				if (struct_type) {
					emit_var_load(status, "x0", node.name, 8);
					anchor_heap_pointer(status, node.name);
				}
			}
		}
		status.last_result_is_heap = prev_heap;
	}

	// Function type declaration
	if (node.func_params) {
		if (status.function_return_label) {
			const offset = allocate_stack_space(status, 8);
			status.stack_offsets!.set(node.name, offset);
		} else {
			emit_data(status, `${node.name}: .space 8`);
		}
		if (node.value && node.value.node_type === "func") {
			build_node(node.value, status);
		} else if (node.value) {
			build_node(node.value, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			emit_var_store(status, "x0", node.name, 8);
		}
		return;
	}

	if (node.type?.name) {
		if (!status.variable_types) status.variable_types = new Map();
		status.variable_types.set(node.name, node.type);
	}

	const directive = aarch64_type(node.type.name);
	const size = aarch64_size(node.type.name);

	// Check if type is a struct
	const struct_type = status.structs.find((s) => s.name === node.type.name && !s.is_simple_type);

	// Don't track class variables initialized from field accesses on classes as owned
	// (they are borrowed references, not owned instances)
	const is_borrowed_class_ref =
		node.type?.name &&
		struct_type &&
		struct_type.is_class &&
		node.value?.node_type === "access" &&
		(node.value as AccessNode).access.node_type === "access_field";

	if (!is_borrowed_class_ref) {
		status.scoped_declarations.push(node);
	}
	if (
		!is_borrowed_class_ref &&
		struct_type &&
		(struct_type.functions.find((f) => f.name === "#destroy") ||
			has_struct_fields_with_destroy(struct_type, status))
	) {
		track_struct_decl(status, node.name, node.type.name, node.type.type_args);
	}

	// Check if type is an enum with associated data
	const enum_type = status.enums.find((e) => e.name === node.type.name && e.has_associated_data);

	if (enum_type) {
		const enum_size = get_enum_size(node.type.name, status);
		if (status.function_return_label) {
			const offset = allocate_stack_space(status, enum_size);
			status.stack_offsets!.set(node.name, offset);
		} else {
			emit_data(status, `${node.name}: .space ${enum_size}\n`);
		}
		if (node.value) {
			build_node(node.value, status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			if (node.value.node_type === "access") {
				emit_var_address(status, "x1", node.name);
				emit_struct_copy("x0", "x1", 0, enum_size, status);
			} else {
				emit_var_store(status, "x0", node.name, 8);
			}
		}
		return;
	}

	if (node.type.is_array) {
		if (node.value && node.value.node_type === "array") {
			const array_values = node.value as ArrayValuesNode;
			const complex = has_complex_elements(array_values.values, status);
			const struct_element = status.structs.find(
				(s) => s.name === node.type.name && !s.is_simple_type,
			);
			const element_size = struct_element
				? struct_element.is_class
					? 8
					: get_struct_size(node.type.name, status)
				: size;

			if (complex) {
				const total_size = array_values.values.length * element_size;
				if (status.function_return_label) {
					const offset = alloc_array_with_prefix(status, array_values.values.length, element_size);
					status.stack_offsets!.set(node.name, offset);
					array_values.values.forEach((value, i) => {
						const slot_offset = offset + i * element_size;
						if (is_class_constructor(value, status)) {
							emit_class_constructor_to_slot(
								value as FunctionCallNode,
								slot_offset,
								status,
								node.name,
							);
						} else if (is_struct_constructor(value, status)) {
							emit_struct_constructor_to_slot(
								value as FunctionCallNode,
								emit_stack_slot_addr(slot_offset),
								status,
							);
						} else {
							const raw = resolve_static_value(value, status);
							if (raw !== null) {
								status.code += `mov x0, #${raw}\n`;
								if (element_size === 1) {
									status.code += `strb w0, [x29, #${slot_offset}]\n`;
								} else if (element_size === 4) {
									status.code += `str w0, [x29, #${slot_offset}]\n`;
								} else {
									status.code += `str x0, [x29, #${slot_offset}]\n`;
								}
							} else {
								build_node(value, status);
								if (!status.code.endsWith("\n")) {
									status.code += "\n";
								}
								status.code += `str x0, [x29, #${slot_offset}]\n`;
								if (struct_element?.is_class) {
									mark_moved_if_struct(value, status);
								}
							}
						}
					});
				} else {
					emit_data(status, `.quad ${array_values.values.length}\n`);
					emit_data(status, `${node.name}: .space ${total_size}\n.p2align 2\n`);
					array_values.values.forEach((value, i) => {
						if (is_struct_constructor(value, status)) {
							emit_global_slot_addr(status, node.name, i * element_size);
							emit_struct_constructor_to_slot(value as FunctionCallNode, "", status);
						} else {
							const raw = resolve_static_value(value, status);
							if (raw !== null) {
								status.code += `ldr x0, =${raw}\n`;
								status.code += `str x0, [${node.name} + ${i * element_size}]\n`;
							} else {
								build_node(value, status);
								if (!status.code.endsWith("\n")) {
									status.code += "\n";
								}
								status.code += `str x0, [${node.name} + ${i * element_size}]\n`;
								if (struct_element?.is_class) {
									mark_moved_if_struct(value, status);
								}
							}
						}
					});
				}
				if (node.type.name === "string" && node.type.is_array) {
					if (!status.heap_string_arrays) status.heap_string_arrays = new Map();
					status.heap_string_arrays.set(node.name, array_values.values.length);
					if (status.heap_cleanup_stack?.length) {
						status.heap_cleanup_stack[status.heap_cleanup_stack.length - 1].heap_strings.add(
							node.name,
						);
					}
				}
			} else if (
				status.function_return_label &&
				node.declaration === "var" &&
				node.type.name !== "string"
			) {
				const offset = alloc_array_with_prefix(status, array_values.values.length, element_size);
				status.stack_offsets!.set(node.name, offset);
				array_values.values.forEach((value, i) => {
					const raw = resolve_static_value(value, status);
					if (raw !== null) {
						status.code += `mov x0, #${raw}\n`;
						if (element_size === 1) {
							status.code += `strb w0, [x29, #${offset + i * element_size}]\n`;
						} else if (element_size === 4) {
							status.code += `str w0, [x29, #${offset + i * element_size}]\n`;
						} else {
							status.code += `str x0, [x29, #${offset + i * element_size}]\n`;
						}
					}
				});
			} else if (status.function_return_label) {
				const labels = emit_string_array_labels(array_values.values, status);
				if (needs_runtime_array_init(array_values.values, status)) {
					const offset = alloc_array_with_prefix(status, array_values.values.length, element_size);
					status.stack_offsets!.set(node.name, offset);
					array_values.values.forEach((value, i) => {
						const slot_offset = offset + i * element_size;
						const resolved = resolve_static_value(value, status);
						if (resolved !== null) {
							const label = resolve_array_element(resolved, labels);
							status.code += `adr x0, ${label}\n`;
							status.code += `str x0, [x29, #${slot_offset}]\n`;
						}
					});
				} else {
					emit_data(status, `${node.name}: ${directive} `);
					array_values.values.forEach((value, i) => {
						if (i > 0) emit_data(status, ", ");
						const resolved = resolve_static_value(value, status);
						emit_data(status, resolved !== null ? resolved : "0");
					});
					emit_data(status, `\n.p2align 2\n`);
				}
			} else if (node.type.name === "string" && node.type.is_array) {
				const labels = emit_string_array_labels(array_values.values, status);
				status.code += `${node.name}: ${directive} `;
				array_values.values.forEach((value, i) => {
					if (i > 0) status.code += ", ";
					const resolved = resolve_static_value(value, status);
					const label = resolved !== null ? resolve_array_element(resolved, labels) : "0";
					status.code += label;
				});
				status.code += `\n.p2align 2\n`;
			} else {
				status.code += `${node.name}: ${directive} `;
				build_array_values_node(array_values, status);
				status.code += `\n.p2align 2\n`;
			}
		} else if (node.value && node.value.node_type === "range") {
			if (status.function_return_label) {
				const range_str = evaluate_range_static(node.value as RangeNode);
				if (range_str !== null) {
					emit_data(status, `${node.name}: ${directive} ${range_str}\n.p2align 2\n`);
				} else {
					emit_data(status, `${node.name}: ${directive} `);
					build_range_node(node.value as RangeNode, status);
					emit_data(status, `\n.p2align 2\n`);
				}
			} else {
				status.code += `${node.name}: ${directive} `;
				build_range_node(node.value as RangeNode, status);
				status.code += `\n.p2align 2\n`;
			}
		} else if (node.value && node.value.node_type === "op") {
			const op = node.value as OperationNode;
			if (op.operator_func && op.type.is_array) {
				const values = resolve_array_values(op, status);
				if (values) {
					if (status.function_return_label && node.declaration === "var") {
						const offset = alloc_array_with_prefix(status, values.length, size);
						status.stack_offsets!.set(node.name, offset);
						values.forEach((val, i) => {
							status.code += `mov x0, #${val}\n`;
							if (size === 1) {
								status.code += `strb w0, [x29, #${offset + i * size}]\n`;
							} else if (size === 4) {
								status.code += `str w0, [x29, #${offset + i * size}]\n`;
							} else {
								status.code += `str x0, [x29, #${offset + i * size}]\n`;
							}
						});
					} else if (status.function_return_label) {
						emit_data(status, `${node.name}: ${directive} ${values.join(", ")}\n.p2align 2\n`);
					} else {
						status.code += `${node.name}: ${directive} ${values.join(", ")}\n.p2align 2\n`;
					}
				} else {
					build_node(node.value, status);
				}
			} else {
				build_node(node.value, status);
			}
		} else if (node.value && node.value.node_type === "func_call") {
			if (!status.heap_array_vars) status.heap_array_vars = new Set();
			status.heap_array_vars.add(node.name);
			const class_element = status.structs.find((s) => s.name === node.type.name && s.is_class);
			if (class_element) {
				if (!status.heap_class_arrays) status.heap_class_arrays = new Map();
				status.heap_class_arrays.set(node.name, 0);
			}
			if (status.function_return_label) {
				const offset = allocate_stack_space(status, 8);
				status.stack_offsets!.set(node.name, offset);
				build_node(node.value, status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				status.code += `str x0, [x29, #${offset}]\n`;
			} else {
				emit_data(status, `${node.name}: .space 8\n.p2align 2\n`);
				build_node(node.value, status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				status.code += `adr x1, ${node.name}\n`;
				status.code += `str x0, [x1]\n`;
			}
			check_heap();
		} else {
			const array_length = node.type.length ? parseInt((node.type.length as ValueNode).value) : 0;
			const array_size = size * array_length;
			if (status.function_return_label && node.declaration === "var") {
				const offset = alloc_array_with_prefix(status, array_length, size);
				status.stack_offsets!.set(node.name, offset);
			} else if (status.function_return_label) {
				emit_data(status, `.quad ${array_length}\n`);
				emit_data(status, `${node.name}: .space ${array_size}\n.p2align 2\n`);
			} else {
				status.code += `.quad ${array_length}\n`;
				status.code += `${node.name}: .space ${array_size}\n.p2align 2\n`;
			}
		}
	} else if (struct_type) {
		if (node.type.is_ref) {
			if (status.function_return_label) {
				const offset = allocate_stack_space(status, 8);
				status.stack_offsets!.set(node.name, offset);
			} else {
				emit_data(status, `${node.name}: .space 8\n`);
			}
			if (node.value) {
				if (node.value.node_type === "value") {
					const src_name = (node.value as ValueNode).value;
					emit_var_address(status, "x0", src_name);
				} else {
					build_node(node.value, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
				}
				emit_var_store(status, "x0", node.name, 8);
			}
			if (!status.function_ref_params) status.function_ref_params = new Set();
			status.function_ref_params.add(node.name);
		} else if (struct_type.is_class) {
			if (status.function_return_label) {
				const offset = allocate_stack_space(status, 8);
				status.stack_offsets!.set(node.name, offset);
			} else {
				emit_data(status, `${node.name}: .space 8\n`);
			}
			if (!status.function_ref_params) status.function_ref_params = new Set();
			status.function_ref_params.add(node.name);
			if (node.value && node.value.node_type === "func_call") {
				const func_call = node.value as FunctionCallNode;
				const is_constructor = status.structs.find(
					(s) => s.name === func_call.name && !s.is_simple_type,
				);
				if (is_constructor) {
					const struct_size = get_struct_size(node.type.name, status);
					status.code += `mov x0, #${struct_size}\n`;
					emit_malloc(status);
					// _param_N temporaries are consumed by the callee function which
					// takes ownership — do not anchor them or they'll be double-freed
					// (once by the anchor cleanup at scope exit, once by the container).
					if (!node.name.startsWith("_param_")) {
						anchor_heap_pointer(status, node.name);
					}
					status.code += `str x0, [x29, #${status.stack_offsets!.get(node.name)}]\n`;
					const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
					for (let i = func_call.params.length - 1; i >= 0; i--) {
						build_node(func_call.params[i], status);
						if (!status.code.endsWith("\n")) {
							status.code += "\n";
						}
						status.code += `mov ${param_regs[i]}, x0\n`;
					}
					emit_var_load(status, "x0", node.name, 8);
					status.code += `bl ${func_call.name}_init\n`;
					if (func_call.mov_param_indices?.length) {
						for (const idx of func_call.mov_param_indices) {
							mark_moved_if_struct(func_call.params[idx], status);
						}
					}
					build_swap_params(func_call, status);
				} else {
					build_node(func_call, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					emit_var_store(status, "x0", node.name, 8);
					check_heap();
				}
			} else if (node.value) {
				if (node.value.node_type === "value") {
					const src_name = (node.value as ValueNode).value;
					emit_var_load(status, "x0", src_name, 8);
				} else {
					build_node(node.value, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
				}
				// A `mov out` method (e.g. List.pop) transfers ownership of its
				// result to this variable — anchor it so it's freed at scope
				// exit, otherwise the relinquished instance leaks.
				if (
					node.value.node_type === "access" &&
					(node.value as AccessNode).access.node_type === "access_func" &&
					((node.value as AccessNode).access as AccessFunctionCallNode).owned_return
				) {
					anchor_heap_pointer(status, node.name);
				}
				emit_var_store(status, "x0", node.name, 8);
			}
		} else {
			// Struct declaration
			const struct_size = get_struct_size(node.type.name, status);
			if (status.function_return_label) {
				const offset = allocate_stack_space(status, struct_size);
				status.stack_offsets!.set(node.name, offset);
			} else {
				emit_data(status, `${node.name}: .space ${struct_size}\n`);
			}
			if (node.value && node.value.node_type === "func_call") {
				const func_call = node.value as FunctionCallNode;
				const is_constructor = status.structs.find(
					(s) => s.name === func_call.name && !s.is_simple_type,
				);
				if (is_constructor) {
					// Evaluate params into x1-x7 first (before setting x0)
					const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
					for (let i = func_call.params.length - 1; i >= 0; i--) {
						const param = func_call.params[i];
						if (param.node_type === "array" && (param as ArrayValuesNode).type?.name === "string") {
							const arr = param as ArrayValuesNode;
							const str_labels: string[] = [];
							arr.values.forEach((v, _idx) => {
								const resolved = resolve_static_value(v, status);
								if (resolved !== null && resolved.startsWith('"')) {
									const label = `_arr_str_${string_array_counter++}`;
									status.code += `${label}: .asciz ${escape_asciz(resolved)}\n.p2align 2\n`;
									str_labels.push(label);
								} else {
									str_labels.push(resolved !== null ? resolved : "0");
								}
							});
							const label = `_arr_param_${string_array_counter++}`;
							status.code += `${label}: .quad ${str_labels.join(", ")}\n.p2align 2\n`;
							status.code += `adr x0, ${label}`;
						} else if (
							(param as any).type?.name &&
							!!status.structs.find(
								(s) => s.name === (param as any).type!.name && !s.is_simple_type,
							)
						) {
							// Struct param: pass by address
							emit_struct_address_param(param, status);
						} else {
							build_node(param, status);
						}
						if (!status.code.endsWith("\n")) {
							status.code += "\n";
						}
						status.code += `mov ${param_regs[i]}, x0\n`;
					}
					// Pass declaration address in x0
					emit_var_address(status, "x0", node.name);
					status.code += `bl ${func_call.name}_init\n`;
					if (func_call.mov_param_indices?.length) {
						for (const idx of func_call.mov_param_indices) {
							mark_moved_if_struct(func_call.params[idx], status);
						}
					}
					build_swap_params(func_call, status);
					// If this is a generic container storing class elements,
					// mark the values buffer so Buffer#destroy frees them.
					const buf_info =
						get_container_class_buffer_field(func_call.name, status) ??
						get_container_class_buffer_field(node.type.name, status);
					if (buf_info) {
						const var_offset = status.stack_offsets!.get(node.name)!;
						const resolved_type = status.structs.find((s) => s.name === func_call.name)
							? func_call.name
							: node.type.name;
						emit_set_container_class_refs_for_type(
							status,
							var_offset,
							resolved_type,
							buf_info.field,
							buf_info.elem,
						);
					}
				} else {
					const func_return_struct = status.structs.find(
						(s) =>
							s.name === (func_call.type?.name ?? func_call.name) &&
							!s.is_simple_type &&
							!s.is_class,
					);
					if (func_return_struct && status.function_return_label) {
						const old_buffer = status.struct_return_buffer;
						emit_var_address(status, "x8", node.name);
						status.struct_return_buffer = "x8";
						build_node(node.value, status);
						status.struct_return_buffer = old_buffer;
						emit_var_address(status, "x0", node.name);
					} else {
						build_node(node.value, status);
						emit_var_store(status, "x0", node.name, struct_size);
					}
					// If this is a generic container storing class elements,
					// mark the values buffer so Buffer#destroy frees them.
					const buf_info2 =
						get_container_class_buffer_field(func_call.name, status) ??
						get_container_class_buffer_field(node.type.name, status);
					if (buf_info2) {
						const var_offset = status.stack_offsets!.get(node.name)!;
						const resolved_type = status.structs.find((s) => s.name === func_call.name)
							? func_call.name
							: node.type.name;
						emit_set_container_class_refs_for_type(
							status,
							var_offset,
							resolved_type,
							buf_info2.field,
							buf_info2.elem,
						);
					}
				}
			} else if (node.value) {
				if (node.value.node_type === "value") {
					const src_name = (node.value as ValueNode).value;
					emit_var_address(status, "x1", src_name);
				} else {
					build_node(node.value, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					status.code += `mov x1, x0\n`;
				}
				emit_var_address(status, "x2", node.name);
				const words = Math.ceil(struct_size / 8);
				for (let i = 0; i < words; i++) {
					status.code += `ldr x3, [x1, #${i * 8}]\n`;
					status.code += `str x3, [x2, #${i * 8}]\n`;
				}
			}
		}
	} else if (node.value) {
		if (node.value.node_type === "op" && (node.value as OperationNode).type?.name === "string") {
			const op = node.value as OperationNode;
			const str_result = resolve_string_op(op, status);
			if (str_result !== null) {
				if (status.function_return_label) {
					emit_data(status, `${node.name}: .asciz ${escape_asciz(str_result)}\n.p2align 2\n`);
				} else {
					status.code += `${node.name}: .asciz ${escape_asciz(str_result)}\n.p2align 2\n`;
				}
				status.string_literal_names!.add(node.name);
			} else {
				build_node(node.value, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				if (status.function_return_label) {
					const offset = allocate_stack_space(status, 8);
					status.stack_offsets!.set(node.name, offset);
					status.code += `str x0, [x29, #${offset}]\n`;
				} else {
					emit_data(status, `${node.name}: .space 8\n`);
					status.code += `adr x1, ${node.name}\n`;
					status.code += `str x0, [x1]\n`;
				}
				check_heap();
			}
		} else if (node.value.node_type === "value") {
			const value_node = node.value as ValueNode;
			const raw = get_raw_value(value_node);
			const is_literal =
				/^(\+|-)?\d+(\.\d+)?$/.test(raw) ||
				raw.startsWith('"') ||
				raw === "true" ||
				raw === "false";
			const use_stack = status.function_return_label && (node.declaration === "var" || !is_literal);
			if (use_stack) {
				const offset = allocate_stack_space(status, size, size);
				status.stack_offsets!.set(node.name, offset);
				const is_heap_alias =
					node.type.name === "string" && !is_literal && status.heap_strings?.has(raw);
				if (is_heap_alias) {
					emit_var_load(status, "x0", raw, 8);
					emit_strdup(status);
					status.code += `str x0, [x29, #${offset}]\n`;
					mark_heap_string(status, node.name);
				} else if (!is_literal) {
					build_node(node.value, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					if (size === 1) {
						status.code += `strb w0, [x29, #${offset}]\n`;
					} else if (size === 4) {
						status.code += `str w0, [x29, #${offset}]\n`;
					} else {
						status.code += `str x0, [x29, #${offset}]\n`;
					}
				} else if (node.type.name === "float") {
					const label = `_float_const_${node.name}`;
					emit_data(status, `${label}: .double ${raw}\n.p2align 2\n`);
					status.code += `adr x0, ${label}\n`;
					status.code += `ldr d0, [x0]\n`;
					status.code += `str d0, [x29, #${offset}]\n`;
				} else if (node.type.name === "string" && raw.startsWith('"')) {
					if (status.force_heap_strings?.has(node.name)) {
						const label = `_str_init_${node.name}`;
						emit_data(status, `${label}: .asciz ${escape_asciz(raw)}\n.p2align 2\n`);
						status.code += `adr x0, ${label}\n`;
						emit_strdup(status);
						status.code += `str x0, [x29, #${offset}]\n`;
						mark_heap_string(status, node.name);
					} else {
						const label = `_str_init_${node.name}`;
						emit_data(status, `${label}: .asciz ${escape_asciz(raw)}\n.p2align 2\n`);
						status.code += `adr x0, ${label}\n`;
						status.code += `str x0, [x29, #${offset}]\n`;
					}
				} else {
					emit_int_immediate(status, raw);
					if (size === 1) {
						status.code += `strb w0, [x29, #${offset}]\n`;
					} else if (size === 4) {
						status.code += `str w0, [x29, #${offset}]\n`;
					} else {
						status.code += `str x0, [x29, #${offset}]\n`;
					}
				}
			} else {
				if (node.type.name === "string" && raw.startsWith('"')) {
					emit_data(status, `${node.name}: .asciz ${escape_asciz(raw)}\n.p2align 2\n`);
					status.string_literal_names!.add(node.name);
				} else {
					emit_data(status, `${node.name}: ${directive} ${raw}\n`);
					if (size % 4 !== 0) {
						emit_data(status, `.p2align 2\n`);
					}
				}
			}
		} else if (node.value.node_type === "array") {
			const array_values = node.value as ArrayValuesNode;
			const complex = has_complex_elements(array_values.values, status);
			if (complex) {
				const total_size = array_values.values.length * size;
				if (status.function_return_label) {
					const offset = alloc_array_with_prefix(status, array_values.values.length, size);
					status.stack_offsets!.set(node.name, offset);
					array_values.values.forEach((value, i) => {
						const slot_offset = offset + i * size;
						if (is_struct_constructor(value, status)) {
							emit_struct_constructor_to_slot(
								value as FunctionCallNode,
								emit_stack_slot_addr(slot_offset),
								status,
							);
						} else {
							const raw = resolve_static_value(value, status);
							if (raw !== null) {
								status.code += `mov x0, #${raw}\n`;
								status.code += `str x0, [x29, #${slot_offset}]\n`;
							}
						}
					});
				} else {
					emit_data(status, `.quad ${array_values.values.length}\n`);
					emit_data(status, `${node.name}: .space ${total_size}\n.p2align 2\n`);
					array_values.values.forEach((value, i) => {
						if (is_struct_constructor(value, status)) {
							emit_global_slot_addr(status, node.name, i * size);
							emit_struct_constructor_to_slot(value as FunctionCallNode, "", status);
						} else {
							const raw = resolve_static_value(value, status);
							if (raw !== null) {
								status.code += `ldr x0, =${raw}\n`;
								status.code += `str x0, [${node.name} + ${i * size}]\n`;
							}
						}
					});
				}
			} else if (status.function_return_label) {
				const labels = emit_string_array_labels(array_values.values, status);
				if (needs_runtime_array_init(array_values.values, status)) {
					const offset = alloc_array_with_prefix(status, array_values.values.length, size);
					status.stack_offsets!.set(node.name, offset);
					array_values.values.forEach((value, i) => {
						const slot_offset = offset + i * size;
						const resolved = resolve_static_value(value, status);
						if (resolved !== null) {
							const label = resolve_array_element(resolved, labels);
							status.code += `adr x0, ${label}\n`;
							status.code += `str x0, [x29, #${slot_offset}]\n`;
						}
					});
				} else {
					emit_data(status, `${node.name}: ${directive} `);
					array_values.values.forEach((value, i) => {
						if (i > 0) emit_data(status, ", ");
						const resolved = resolve_static_value(value, status);
						emit_data(status, resolved !== null ? resolved : "0");
					});
					emit_data(status, `\n.p2align 2\n`);
				}
				if (node.type.name === "string" && node.type.is_array) {
					if (!status.heap_string_arrays) status.heap_string_arrays = new Map();
					status.heap_string_arrays.set(node.name, array_values.values.length);
					if (status.heap_cleanup_stack?.length) {
						status.heap_cleanup_stack[status.heap_cleanup_stack.length - 1].heap_strings.add(
							node.name,
						);
					}
				}
			} else {
				status.code += `.quad ${array_values.values.length}\n`;
				status.code += `${node.name}: ${directive} `;
				build_array_values_node(array_values, status);
				status.code += `\n.p2align 2\n`;
			}
		} else if (node.value.node_type === "range") {
			const range_len = compute_range_length(node.value as RangeNode);
			if (status.function_return_label) {
				const range_str = evaluate_range_static(node.value as RangeNode);
				if (range_str !== null) {
					emit_data(status, `.quad ${range_len}\n`);
					emit_data(status, `${node.name}: ${directive} ${range_str}\n.p2align 2\n`);
				} else {
					emit_data(status, `.quad ${range_len}\n`);
					emit_data(status, `${node.name}: ${directive} `);
					build_range_node(node.value as RangeNode, status);
					emit_data(status, `\n.p2align 2\n`);
				}
			} else {
				status.code += `.quad ${range_len}\n`;
				status.code += `${node.name}: ${directive} `;
				build_range_node(node.value as RangeNode, status);
				status.code += `\n.p2align 2\n`;
			}
		} else if (
			node.value.node_type === "if" ||
			node.value.node_type === "match" ||
			node.value.node_type === "switch"
		) {
			if (status.function_return_label) {
				const offset = allocate_stack_space(status, size, size);
				status.stack_offsets!.set(node.name, offset);
			} else {
				emit_data(status, `${node.name}: .space ${size}\n`);
			}
			const old_return_assign = status.return_assign;
			status.return_assign = node.name;
			build_node(node.value, status);
			status.return_assign = old_return_assign;
			check_heap();
		} else {
			if (status.function_return_label) {
				const offset = allocate_stack_space(status, size, size);
				status.stack_offsets!.set(node.name, offset);
			} else {
				emit_data(status, `${node.name}: .space ${size}\n`);
			}
			build_node(node.value, status);
			emit_var_store(status, "x0", node.name, size);
			check_heap();
		}
	} else {
		const array_length =
			node.type.is_array && node.type.length ? parseInt((node.type.length as ValueNode).value) : 0;
		const total_size = node.type.is_array ? size * array_length : size;
		const use_stack = status.function_return_label;
		if (use_stack) {
			if (node.type.is_array) {
				const offset = alloc_array_with_prefix(status, array_length, size);
				status.stack_offsets!.set(node.name, offset);
			} else {
				const offset = allocate_stack_space(status, total_size, size);
				status.stack_offsets!.set(node.name, offset);
			}
		} else {
			if (node.type.is_array) {
				emit_data(status, `.quad ${array_length}\n`);
			}
			emit_data(status, `${node.name}: .space ${total_size}\n`);
			if (total_size % 4 !== 0) {
				emit_data(status, `.p2align 2\n`);
			}
		}
	}
}

function evaluate_range_static(node: RangeNode): string | null {
	const start = evaluate_range_const(node.left_value);
	const end = evaluate_range_const(node.right_value);
	if (start !== undefined && end !== undefined) {
		const actual_end = end;
		return [...Array(actual_end - start).keys()].map((v) => start + v).join(", ");
	}
	return null;
}

function compute_range_length(node: RangeNode): number {
	const start = evaluate_range_const(node.left_value);
	const end = evaluate_range_const(node.right_value);
	if (start !== undefined && end !== undefined) {
		return end - start;
	}
	return 0;
}

function evaluate_range_const(node: any): number | undefined {
	if (node.node_type === "value") {
		const n = parseInt(node.value);
		if (!isNaN(n)) return n;
	}
	if (node.node_type === "grouped") {
		return evaluate_range_const(node.value);
	}
	if (node.node_type === "op") {
		const left = evaluate_range_const(node.left_value);
		const right = evaluate_range_const(node.right_value);
		if (left !== undefined && right !== undefined) {
			switch (node.op) {
				case "+":
					return left + right;
				case "-":
					return left - right;
				case "*":
					return left * right;
				case "/":
					return Math.floor(left / right);
			}
		}
	}
	return undefined;
}
