import emit_field_overrides from "../build/emit_field_overrides.ts";
import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { is_int_literal, parse_int_literal_bigint, to_decimal_string } from "../int_literal.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { emit_address_of } from "./build_access_node.ts";
import build_array_values_node, { resolve_static_value } from "./build_array_values_node.ts";
import { get_source_address } from "./build_assignment_node.ts";
import build_node from "./build_node.ts";
import build_range_node from "./build_range_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import aarch64_type from "./utils/aarch64_type.ts";
import { emit_strdup, emit_malloc } from "./utils/audit.ts";
import {
	anchor_heap_pointer,
	consolidate_temp_anchors,
	mark_anchor_destroy,
	mark_heap_string,
	mark_moved_if_struct,
	track_struct_decl,
	has_struct_fields_with_destroy,
} from "./utils/auto_destroy.ts";
import { build_swap_params } from "./utils/build_swap.ts";
import { has_flag_name, is_nullable_struct_type } from "./utils/nullable_struct.ts";
import { NUM_REG_ARGS } from "./utils/stack_args.ts";
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
// use a `ldr =imm` literal pool load. Accepts any base (hex/oct/bin/decimal)
// via `to_decimal_string`, since the assembler rejects `#0x..`/`#0o..`/`#0b..`.
function emit_int_immediate(status: BuildStatus, raw: string) {
	const dec = to_decimal_string(raw);
	const n = parse_int_literal_bigint(raw);
	if (n !== null && n >= 0n && n <= 65535n) {
		status.code += `mov x0, #${dec}\n`;
	} else if (n !== null && n < 0n && n >= -65536n) {
		status.code += `movn x0, #${(-n - 1n).toString()}\n`;
	} else {
		status.code += `ldr x0, =${dec}\n`;
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

/** Whether a node's type is a (non-simple) struct/class value type. */
function is_struct_type_node(node: BaseNode, status: BuildStatus): boolean {
	const t = type_from_value_node(node);
	return !!t?.name && !!status.structs.find((s) => s.name === t.name && !s.is_simple_type);
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
let decl_const_counter = 0;

/** Reset module-level label counters so repeated builds of the same AST emit
 *  identical labels (the AST is shared across backends / repeated builds). */
export function reset_decl_const_counters() {
	string_array_counter = 0;
	decl_const_counter = 0;
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

export { emit_string_array_labels };

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

export { resolve_array_element };

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
	if (is_int_literal(val)) return to_decimal_string(val);
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
	const outgoing = build_constructor_params(fc, param_regs, status);
	status.code += `ldr x0, [x29, #${slot_offset}]\n`;
	status.code += `bl ${fc.name}_init\n`;
	if (outgoing > 0) status.code += `add sp, sp, #${outgoing}\n`;
}

function emit_struct_constructor_to_slot(
	fc: FunctionCallNode,
	slot_addr: string,
	status: BuildStatus,
) {
	const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
	const outgoing = build_constructor_params(fc, param_regs, status);
	status.code += slot_addr;
	status.code += `bl ${fc.name}_init\n`;
	if (outgoing > 0) status.code += `add sp, sp, #${outgoing}\n`;
}

/**
 * Evaluate a constructor's params right-to-left into argument registers,
 * spilling each to a stack slot first so a later arg's evaluation can't
 * clobber an earlier arg's register. Struct/enum args are passed by address.
 *
 * Variadic-tuple constructors (e.g. Map<K,V>'s `#init(self, ...[K,V] pairs)`)
 * are packed: the variadic args go into a stack array, and the callee receives
 * a (count, pointer) pair in the two register slots the variadic param
 * occupies — mirroring the regular call convention in build_function_call_node.
 *
 * Returns the outgoing stack-arg area size (0 if no overflow). When > 0, the
 * caller has had sp lowered by that amount and must `add sp, sp, #outgoing`
 * after the `bl`. Constructor calls reserve x0 for the destination pointer,
 * so register slots start at x1 — overflow begins at the 8th arg (slot 8).
 */
function build_constructor_params(
	fc: FunctionCallNode,
	param_regs: string[],
	status: BuildStatus,
): number {
	const variadic_idx = fc.variadic_param_index;
	if (
		variadic_idx !== undefined &&
		fc.params[variadic_idx] &&
		fc.params[variadic_idx].node_type === "array"
	) {
		const arr = fc.params[variadic_idx] as ArrayValuesNode;
		const elem_type_name = arr.type.name || "int";
		const elem_struct = status.structs.find((s) => s.name === elem_type_name && !s.is_simple_type);
		const elem_size = elem_struct ? get_struct_size(elem_type_name, status) : 8;
		const count = arr.values.length;
		// Always reserve at least one element so the pointer we pass is a valid,
		// uniquely-owned stack address even when there are zero variadic args.
		const arr_offset = allocate_stack_space(status, Math.max(count, 1) * elem_size, 16);

		// Evaluate each variadic arg into its slot (right-to-left).
		for (let j = count - 1; j >= 0; j--) {
			const arg = arr.values[j];
			const slot_offset = arr_offset + j * elem_size;
			if (elem_struct && arg.node_type === "func_call") {
				// Tuple/struct constructor: eval params into x1..x7, then call _init
				// with x0 pointing at this slot.
				const tfc = arg as FunctionCallNode;
				const fc_param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
				for (let k = tfc.params.length - 1; k >= 0; k--) {
					build_node(tfc.params[k], status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `mov ${fc_param_regs[k]}, x0\n`;
				}
				status.code += `add x0, x29, #${slot_offset}\n`;
				status.code += `bl ${tfc.name}_init\n`;
			} else if (elem_struct) {
				emit_struct_address_param(arg, status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				status.code += `mov x1, x0\n`;
				status.code += `add x0, x29, #${slot_offset}\n`;
				for (let b = 0; b < elem_size; b += 8) {
					status.code += `ldr x2, [x1, #${b}]\n`;
					status.code += `str x2, [x0, #${b}]\n`;
				}
			} else {
				build_node(arg, status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				status.code += `str x0, [x29, #${slot_offset}]\n`;
			}
		}

		// Non-variadic params (everything except the packed array). They occupy
		// the register slots before the variadic count/pointer.
		const non_variadic: { node: BaseNode; by_address: boolean }[] = [];
		for (let i = 0; i < fc.params.length; i++) {
			if (i === variadic_idx) continue;
			const param = fc.params[i];
			const param_type = (param as any).type?.name || "";
			const by_address =
				!!status.structs.find((s) => s.name === param_type && !s.is_simple_type) ||
				!!status.enums.find((e) => e.name === param_type && e.has_associated_data);
			non_variadic.push({ node: param, by_address });
		}
		const nv = non_variadic.length;
		// The non-variadic params plus the hidden (count, pointer) pair occupy
		// `nv + 2` slots: non-variadic first (param_regs indices 0..nv-1, i.e.
		// x1..), then the count (index nv) and array pointer (index nv+1).
		// x0 is reserved for the destination pointer, so register slots run
		// x1..x7 (7 slots); anything past slot 7 (slot 8+) overflows into the
		// caller's outgoing stack area. Spill every slot first, then load the
		// in-register slots and copy the overflow slots to the outgoing area.
		const total_slots = nv + 2;
		const slots_base = allocate_stack_space(status, total_slots * 8, 16);
		const count_slot = slots_base + nv * 8;
		const ptr_slot = count_slot + 8;

		// Spill non-variadic params right-to-left (their evaluation may
		// clobber any register).
		for (let i = nv - 1; i >= 0; i--) {
			const ep = non_variadic[i];
			if (ep.by_address) {
				emit_struct_address_param(ep.node, status);
			} else {
				build_node(ep.node, status);
			}
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `str x0, [x29, #${slots_base + i * 8}]\n`;
		}

		// Store the count and array pointer into their slots.
		emit_int_immediate(status, String(count));
		if (!status.code.endsWith("\n")) status.code += "\n";
		status.code += `str x0, [x29, #${count_slot}]\n`;
		status.code += `add x0, x29, #${arr_offset}\n`;
		status.code += `str x0, [x29, #${ptr_slot}]\n`;

		// Load in-register slots (x1..x7). param_regs index i maps to slot
		// i+1; indices past slot 7 are overflow.
		const reg_slots = Math.min(total_slots, NUM_REG_ARGS - 1);
		for (let i = 0; i < reg_slots; i++) {
			status.code += `ldr ${param_regs[i]}, [x29, #${slots_base + i * 8}]\n`;
		}

		// AAPCS64: slots past x7 go in the caller's outgoing area at [sp] at
		// the moment of the bl. The caller restores sp after the bl.
		const overflow_count = Math.max(0, total_slots - (NUM_REG_ARGS - 1));
		if (overflow_count > 0) {
			const outgoing_size = Math.ceil((overflow_count * 8) / 16) * 16;
			status.code += `sub sp, sp, #${outgoing_size}\n`;
			const overflow_first = NUM_REG_ARGS - 1;
			for (let k = 0; k < overflow_count; k++) {
				status.code += `ldr x9, [x29, #${slots_base + (overflow_first + k) * 8}]\n`;
				status.code += `str x9, [sp, #${k * 8}]\n`;
			}
			return outgoing_size;
		}
		return 0;
	}

	const has_args = fc.params.length > 0;
	let base = 0;
	if (has_args) {
		base = allocate_stack_space(status, fc.params.length * 8, 16);
	}
	for (let i = fc.params.length - 1; i >= 0; i--) {
		const param = fc.params[i];
		const param_type = (param as any).type?.name || "";
		if (param.node_type === "array" && param_type === "string") {
			// Static string-array arg: emit a .quad data label and pass its address.
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
			status.code += `adr x0, ${label}\n`;
		} else if (fc.nullable_param_indices?.includes(i)) {
			// A nullable struct value field (`T? field`, T a non-class
			// struct) needs combined `[struct | flag]` storage at the call
			// site so the constructor (which writes the field through the
			// destination pointer) reads the flag at `[field_addr +
			// struct_size]`. Same shapes as the free-function path in
			// build_function_call_node.
			const arg = param;
			const struct_size = get_struct_size(param_type, status);
			if (arg.node_type === "value" && (arg as ValueNode).value === "null") {
				// `null` arg: zero the flag slot, leave value bytes
				// uninitialised (the constructor won't read them).
				const off = allocate_stack_space(status, struct_size + 8);
				status.code += `str xzr, [x29, #${off + struct_size}]\n`;
				status.code += `add x0, x29, #${off}\n`;
			} else if (
				arg.node_type === "value" &&
				is_nullable_struct_type((arg as ValueNode).type, status)
			) {
				// Bare nullable variable — its storage is already combined.
				emit_var_address(status, "x0", (arg as ValueNode).value);
			} else {
				// Non-null rvalue: build it (lands its address in x0),
				// materialise into a combined region with value + flag = 1.
				emit_struct_address_param(arg, status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				const off = allocate_stack_space(status, struct_size + 8);
				for (let b = 0; b < struct_size; b += 8) {
					status.code += `ldr x9, [x0, #${b}]\n`;
					status.code += `str x9, [x29, #${off + b}]\n`;
				}
				status.code += `mov x9, #1\n`;
				status.code += `str x9, [x29, #${off + struct_size}]\n`;
				status.code += `add x0, x29, #${off}\n`;
			}
		} else if (
			!!status.structs.find((s) => s.name === param_type && !s.is_simple_type) ||
			!!status.enums.find((e) => e.name === param_type && e.has_associated_data)
		) {
			emit_struct_address_param(param, status);
		} else {
			build_node(param, status);
		}
		if (!status.code.endsWith("\n")) status.code += "\n";
		status.code += `str x0, [x29, #${base + i * 8}]\n`;
	}
	// `param_regs` is ["x1".."x7"] — slot index for arg i is i+1 (x0 is the
	// destination pointer). Load each in-register arg, skipping args whose
	// slot falls past x7 (those are spilled to the outgoing area below).
	for (let i = 0; i < fc.params.length; i++) {
		const slot = i + 1;
		if (slot >= NUM_REG_ARGS) continue;
		status.code += `ldr ${param_regs[i]}, [x29, #${base + i * 8}]\n`;
	}
	// AAPCS64: args past slot 7 go in the caller's outgoing area at [sp] at
	// the moment of the bl. Lower sp by the outgoing area size and copy each
	// overflow arg from its spill slot; the caller restores sp after the bl.
	const overflow_count = Math.max(0, fc.params.length - (NUM_REG_ARGS - 1));
	if (overflow_count > 0) {
		const outgoing_size = Math.ceil((overflow_count * 8) / 16) * 16;
		status.code += `sub sp, sp, #${outgoing_size}\n`;
		const overflow_first = NUM_REG_ARGS - 1;
		for (let k = 0; k < overflow_count; k++) {
			status.code += `ldr x9, [x29, #${base + (overflow_first + k) * 8}]\n`;
			status.code += `str x9, [sp, #${k * 8}]\n`;
		}
		return outgoing_size;
	}
	return 0;
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

	// Substitute a top-level non-primitive `const` reference (e.g.
	// `var LayoutParams p = DEFAULT_PARAMS`) with the const's initializer.
	// The const is inlined at every use site (see build_block_node +
	// build_value_node); without this, the struct-copy fast path below would
	// emit `adr x1, DEFAULT_PARAMS` against a global that no longer exists.
	if (node.value?.node_type === "value") {
		const inlined = status.top_level_consts?.get((node.value as ValueNode).value);
		if (inlined?.value) node.value = inlined.value;
	}

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
					consolidate_temp_anchors(status, node.value, node.type.name);
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

	// `view T` local: a non-owning (ptr, len) value occupying two stack slots.
	// It is produced by a slice() call in the x0/x1 register pair and is never
	// auto-freed (it owns no heap). Handle it up front, before the
	// struct/primitive routing below.
	if (node.type.is_view) {
		const base = allocate_stack_space(status, 16, 16);
		status.stack_offsets!.set(node.name, base);
		if (node.value) {
			build_node(node.value, status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			// slice returns (ptr, len) in x0/x1 — spill both into the local.
			status.code += `str x0, [x29, #${base}]\n`;
			status.code += `str x1, [x29, #${base + 8}]\n`;
		}
		return;
	}

	const directive = aarch64_type(node.type.name);
	const size = aarch64_size(node.type.name);

	// Resolve a generic-typed declaration (e.g. `var Box<Point> b`) to its
	// monomorphized struct name (Box_Point) so the struct lookup, size
	// computation, and field layout all key against the concrete struct.
	// Mirrors the C backend's mono_name resolution. The Nomen type is left
	// unchanged (the AST is shared across backends).
	const resolved_struct_name = node.type.type_args?.length
		? `${node.type.name}_${node.type.type_args.map((t) => t.name).join("_")}`
		: node.type.name;

	// Check if type is a struct
	const struct_type = status.structs.find(
		(s) => s.name === resolved_struct_name && !s.is_simple_type,
	);

	// A trait-typed local stores the concrete struct value (the initializer's
	// actual type) so its vtable (offset 0) and field layout are correct for
	// trait-typed dispatch and the generated field accessors. Allocate the
	// concrete struct's size and run its constructor into that storage. The
	// Nomen type stays the trait (set above) so method/field accesses dispatch
	// through the vtable rather than lowering to a direct call.
	if (
		!struct_type &&
		!!status.traits.find((t) => t.name === node.type.name) &&
		node.value &&
		node.value.node_type === "func_call"
	) {
		const val_type = type_from_value_node(node.value);
		const concrete = status.structs.find(
			(s) => s.name === val_type?.name && !s.is_simple_type && !s.is_generic,
		);
		if (concrete) {
			// A trait-typed local whose concrete storage is a `class` holds a
			// pointer to the heap instance (not the inline struct), so it can
			// be reassigned to a different conforming class. Malloc the
			// instance, store the pointer, and run the constructor into it.
			// Track in trait_class_locals so method dispatch dereferences the
			// stored pointer to reach the vtable. The instance is anchored
			// with destroy_type = trait name, so every cleanup path
			// (scope-exit / return / break) reclaims it via the trait's
			// `<Trait>_destroy` shim + free — the concrete type at runtime may
			// differ from the initializer's after reassignment, so destroy
			// must dispatch polymorphically.
			if (concrete.is_class) {
				if (!status.trait_class_locals) status.trait_class_locals = new Map();
				status.trait_class_locals.set(node.name, node.type.name);
				const struct_size = get_struct_size(concrete.name, status);
				if (status.function_return_label) {
					const offset = allocate_stack_space(status, 8);
					status.stack_offsets!.set(node.name, offset);
				} else {
					emit_data(status, `${node.name}: .space 8\n`);
				}
				const func_call = node.value as FunctionCallNode;
				if (func_call.name === concrete.name) {
					status.code += `mov x0, #${struct_size}\n`;
					emit_malloc(status);
					emit_var_store(status, "x0", node.name, 8);
					anchor_heap_pointer(status, node.name, undefined, node.type.is_nullable);
					mark_anchor_destroy(status, node.name, node.type.name);
					const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
					const outgoing = build_constructor_params(func_call, param_regs, status);
					emit_var_load(status, "x0", node.name, 8);
					status.code += `bl ${func_call.name}_init\n`;
					if (outgoing > 0) status.code += `add sp, sp, #${outgoing}\n`;
					if (func_call.mov_param_indices?.length) {
						for (const idx of func_call.mov_param_indices) {
							mark_moved_if_struct(func_call.params[idx], status);
						}
					}
					build_swap_params(func_call, status);
				} else {
					build_node(node.value, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					emit_var_store(status, "x0", node.name, 8);
					anchor_heap_pointer(status, node.name, undefined, node.type.is_nullable);
					mark_anchor_destroy(status, node.name, node.type.name);
				}
				return;
			}
			// Track the trait-typed local for scope-exit destroy: push to
			// scoped_declarations (emit_destroy_for_scope recovers the
			// concrete struct from the initializer — node.type.name stays the
			// trait so method/field accesses still dispatch through the
			// vtable) and record it with the concrete type name so
			// break/continue cleanup (emit_cleanup_to_loop_depth) destroys it
			// correctly too.
			status.scoped_declarations.push(node);
			if (
				concrete.functions.find((f) => f.name === "#destroy") ||
				has_struct_fields_with_destroy(concrete, status)
			) {
				track_struct_decl(status, node.name, concrete.name, undefined, node.type.is_nullable);
			}
			const func_call = node.value as FunctionCallNode;
			const struct_size = get_struct_size(concrete.name, status);
			if (status.function_return_label) {
				const offset = allocate_stack_space(status, struct_size);
				status.stack_offsets!.set(node.name, offset);
			} else {
				emit_data(status, `${node.name}: .space ${struct_size}\n`);
			}
			if (func_call.name === concrete.name) {
				const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
				const outgoing = build_constructor_params(func_call, param_regs, status);
				emit_var_address(status, "x0", node.name);
				status.code += `bl ${func_call.name}_init\n`;
				if (outgoing > 0) status.code += `add sp, sp, #${outgoing}\n`;
				if (func_call.mov_param_indices?.length) {
					for (const idx of func_call.mov_param_indices) {
						mark_moved_if_struct(func_call.params[idx], status);
					}
				}
				build_swap_params(func_call, status);
			} else {
				// Struct-returning function: pass the destination address via x8.
				const old_buffer = status.struct_return_buffer;
				emit_var_address(status, "x8", node.name);
				status.struct_return_buffer = "x8";
				build_node(node.value, status);
				status.struct_return_buffer = old_buffer;
			}
			return;
		}
	}
	// A trait-typed local initialized from a method-call return (e.g.
	// `var Speaker p = pets.at(i)` or `var Speaker p = pets.pop()`)
	// holds a vtable-bearing class pointer the callee already allocated
	// — the concrete struct isn't statically known (the method's
	// declared return type is the trait), so storage must be an 8-byte
	// pointer dispatched through the trait vtable. The
	// ClassBuffer<Trait> slot already stores a correct vtable-bearing
	// class pointer, so dispatch works once the local is tracked in
	// trait_class_locals (build_access_node dereferences [&local] to
	// reach the instance whose vtable lives at offset 0). Ownership
	// follows the callee's return convention: a `mov out T` method
	// (`owned_return`, e.g. `list.pop()`) transfers ownership (anchor
	// for destroy + free at scope exit via the trait's `<Trait>_destroy`
	// shim); a plain borrow (e.g. `.at(i)`) does not (the container
	// still owns the element), so the local is not anchored for destroy.
	if (
		!struct_type &&
		!!status.traits.find((t) => t.name === node.type.name) &&
		node.value?.node_type === "access" &&
		(node.value as AccessNode).access.node_type === "access_func"
	) {
		const inner = (node.value as AccessNode).access as AccessFunctionCallNode;
		if (!status.trait_class_locals) status.trait_class_locals = new Map();
		status.trait_class_locals.set(node.name, node.type.name);
		if (status.function_return_label) {
			const offset = allocate_stack_space(status, 8);
			status.stack_offsets!.set(node.name, offset);
		} else {
			emit_data(status, `${node.name}: .space 8\n`);
		}
		build_node(node.value, status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		emit_var_store(status, "x0", node.name, 8);
		if (inner.owned_return) {
			anchor_heap_pointer(status, node.name, undefined, node.type.is_nullable);
			mark_anchor_destroy(status, node.name, node.type.name);
		}
		return;
	}

	// Don't track class variables that hold a borrowed reference (not an owned
	// instance) as owned — they must not be destroyed/freed at scope exit.
	// Borrows arise from a field access (`var Box b = h.c`) or a plain
	// class-variable copy (`var Box q = p`); the latter would otherwise be
	// destroyed alongside the original owner, double-freeing / double-destroying
	// the instance. `mov p` (ownership transfer) and `null` stay owned.
	const value_is_field_borrow =
		node.value?.node_type === "access" &&
		(node.value as AccessNode).access.node_type === "access_field";
	const value_is_var_borrow =
		node.value?.node_type === "value" &&
		!(node.value as ValueNode).is_moved &&
		(node.value as ValueNode).value !== "null";
	const is_borrowed_class_ref = !!(
		node.type?.name &&
		struct_type &&
		struct_type.is_class &&
		(value_is_field_borrow || value_is_var_borrow)
	);

	if (!is_borrowed_class_ref) {
		status.scoped_declarations.push(node);
	}
	// Record the declaration frame for every class-typed variable so that a
	// later reassignment of an object-level alias can anchor its new instance
	// in the right frame (the alias itself has no anchor to derive this from).
	if (struct_type?.is_class) {
		const top = (status.heap_cleanup_stack?.length ?? 1) - 1;
		status.class_decl_frame?.set(node.name, top);
	}
	// Track class vars declared as aliases (not freed via scoped_declarations)
	// so reassignment knows to flag their anchor for #destroy at scope exit.
	if (is_borrowed_class_ref) {
		status.class_alias_vars?.add(node.name);
		// Allocate a runtime ownership flag for the alias. An alias only owns
		// its value after its first reassignment to a fresh instance, so a loop
		// that reassigns the alias must decide at runtime (via this flag)
		// whether to free the old instance — the build-time `owns_current`
		// check is evaluated once and can't track per-iteration ownership.
		// The flag is a fixed stack offset in the alias's frame, so it
		// persists across loop iterations; init to 0 (does not own yet).
		if (status.function_return_label) {
			const flag_offset = allocate_stack_space(status, 8, 8);
			status.code += `str xzr, [x29, #${flag_offset}]\n`;
			status.alias_owns_flag?.set(node.name, flag_offset);
		}
	}
	if (
		!is_borrowed_class_ref &&
		struct_type &&
		(struct_type.functions.find((f) => f.name === "#destroy") ||
			has_struct_fields_with_destroy(struct_type, status))
	) {
		track_struct_decl(
			status,
			node.name,
			node.type.name,
			node.type.type_args,
			node.type.is_nullable,
		);
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
			if (
				node.value.node_type === "access" ||
				(node.value.node_type === "value" &&
					(node.value as ValueNode).is_enum_shorthand &&
					status.enums.find((e) => e.name === node.type.name && e.has_associated_data))
			) {
				emit_var_address(status, "x1", node.name);
				emit_struct_copy("x0", "x1", 0, enum_size, status);
			} else {
				emit_var_store(status, "x0", node.name, 8);
			}
		}
		return;
	}

	if (node.type.is_array) {
		// A hoisted array-literal/range temp bound to a heap `Array<T>` param,
		// or a heap `Array<T>` declared directly with a literal/range
		// initializer (`var Array<int> x = [2,4,6]`): materialise a malloc'd
		// buffer ([ptr]=length, data at [ptr+8]) so the promoted `Array_<T>`
		// param's `.length`/`.at`/`.set`/iteration see the heap-array layout.
		// Register it in `heap_array_vars` so auto-destroy frees the buffer.
		// String elements store `.asciz` addresses without strdup (matching the
		// aarch64 `Array.with`/`set` convention — they are rodata, not owned),
		// so they are NOT registered in heap_string_arrays; class elements are
		// fresh constructor results owned by the buffer, so they go to
		// heap_class_arrays for per-element free.
		const heap_literal_init =
			node.is_heap_array_literal ||
			(node.type.storage_kind === "heap_array" &&
				(node.value?.node_type === "array" || node.value?.node_type === "range"));
		const array_literal_values =
			heap_literal_init && node.value?.node_type === "array"
				? (node.value as ArrayValuesNode).values
				: undefined;
		const range_literal_values =
			heap_literal_init && node.value?.node_type === "range"
				? range_to_values(node.value as RangeNode)
				: undefined;
		if (array_literal_values || range_literal_values) {
			const values = array_literal_values ?? (range_literal_values as string[]);
			const is_range = !!range_literal_values;
			const struct_element = status.structs.find(
				(s) => s.name === node.type.name && !s.is_simple_type,
			);
			const element_size = struct_element
				? struct_element.is_class
					? 8
					: get_struct_size(node.type.name, status)
				: size;
			if (!status.heap_array_vars) status.heap_array_vars = new Set();
			status.heap_array_vars.add(node.name);
			const class_element = status.structs.find((s) => s.name === node.type.name && s.is_class);
			if (class_element) {
				if (!status.heap_class_arrays) status.heap_class_arrays = new Map();
				status.heap_class_arrays.set(node.name, 0);
			}
			const str_labels = emit_string_array_labels(
				values.filter((v): v is BaseNode => typeof v !== "string"),
				status,
			);
			if (status.function_return_label) {
				const offset = allocate_stack_space(status, 8);
				status.stack_offsets!.set(node.name, offset);
				// x0 = malloc(8 + count * element_size)
				status.code += `mov x0, #${values.length}\n`;
				status.code += `mov x1, #${element_size}\n`;
				status.code += `mul x0, x0, x1\n`;
				status.code += `add x0, x0, #8\n`;
				emit_malloc(status);
				status.code += `str x0, [x29, #${offset}]\n`;
				status.code += `ldr x9, [x29, #${offset}]\n`;
				status.code += `mov x0, #${values.length}\n`;
				status.code += `str x0, [x9]\n`;
				values.forEach((value, i) => {
					const slot = 8 + i * element_size;
					const raw = is_range ? value : resolve_static_value(value as BaseNode, status);
					if (typeof raw === "string" && raw.startsWith('"')) {
						const label = resolve_array_element(raw, str_labels);
						status.code += `adr x0, ${label}\n`;
						status.code += `ldr x9, [x29, #${offset}]\n`;
						status.code += `str x0, [x9, #${slot}]\n`;
					} else if (typeof raw === "string") {
						emit_int_immediate(status, raw);
						status.code += `ldr x9, [x29, #${offset}]\n`;
						if (element_size === 1) {
							status.code += `strb w0, [x9, #${slot}]\n`;
						} else if (element_size === 4) {
							status.code += `str w0, [x9, #${slot}]\n`;
						} else {
							status.code += `str x0, [x9, #${slot}]\n`;
						}
					} else {
						build_node(value as BaseNode, status);
						if (!status.code.endsWith("\n")) status.code += "\n";
						status.code += `ldr x9, [x29, #${offset}]\n`;
						if (element_size === 1) {
							status.code += `strb w0, [x9, #${slot}]\n`;
						} else if (element_size === 4) {
							status.code += `str w0, [x9, #${slot}]\n`;
						} else {
							status.code += `str x0, [x9, #${slot}]\n`;
						}
					}
				});
			} else {
				emit_data(status, `${node.name}: .space 8\n.p2align 2\n`);
				status.code += `mov x0, #${values.length}\n`;
				status.code += `mov x1, #${element_size}\n`;
				status.code += `mul x0, x0, x1\n`;
				status.code += `add x0, x0, #8\n`;
				emit_malloc(status);
				status.code += `adr x1, ${node.name}\n`;
				status.code += `str x0, [x1]\n`;
				status.code += `ldr x9, [x1]\n`;
				status.code += `mov x0, #${values.length}\n`;
				status.code += `str x0, [x9]\n`;
				values.forEach((value, i) => {
					const slot = 8 + i * element_size;
					const raw = is_range ? value : resolve_static_value(value as BaseNode, status);
					if (typeof raw === "string" && raw.startsWith('"')) {
						const label = resolve_array_element(raw, str_labels);
						status.code += `adr x0, ${label}\n`;
						status.code += `ldr x9, [${node.name}]\n`;
						status.code += `str x0, [x9, #${slot}]\n`;
					} else if (typeof raw === "string") {
						emit_int_immediate(status, raw);
						status.code += `ldr x9, [${node.name}]\n`;
						if (element_size === 1) {
							status.code += `strb w0, [x9, #${slot}]\n`;
						} else if (element_size === 4) {
							status.code += `str w0, [x9, #${slot}]\n`;
						} else {
							status.code += `str x0, [x9, #${slot}]\n`;
						}
					} else {
						build_node(value as BaseNode, status);
						if (!status.code.endsWith("\n")) status.code += "\n";
						status.code += `ldr x9, [${node.name}]\n`;
						if (element_size === 1) {
							status.code += `strb w0, [x9, #${slot}]\n`;
						} else if (element_size === 4) {
							status.code += `str w0, [x9, #${slot}]\n`;
						} else {
							status.code += `str x0, [x9, #${slot}]\n`;
						}
					}
				});
			}
			return;
		}
		// A hoisted COPY temp for a stack-array variable arg bound to a heap
		// `Array<T>` param: materialise a malloc'd buffer and copy the source
		// stack array's inline elements in. String elements copy the stored
		// pointer as-is (aarch64 stack string arrays hold `.asciz` addresses,
		// not owned copies — neither side frees them).
		if (node.is_heap_array_copy && node.value?.node_type === "value") {
			const src_name = (node.value as ValueNode).value;
			const src_type = type_from_value_node(node.value);
			const struct_element = status.structs.find(
				(s) => s.name === node.type.name && !s.is_simple_type,
			);
			const element_size = struct_element
				? struct_element.is_class
					? 8
					: get_struct_size(node.type.name, status)
				: size;
			const count = src_type.length ? parseInt((src_type.length as ValueNode).value || "0") : 0;
			if (!status.heap_array_vars) status.heap_array_vars = new Set();
			status.heap_array_vars.add(node.name);
			if (status.function_return_label) {
				const offset = allocate_stack_space(status, 8);
				status.stack_offsets!.set(node.name, offset);
				status.code += `mov x0, #${count}\n`;
				status.code += `mov x1, #${element_size}\n`;
				status.code += `mul x0, x0, x1\n`;
				status.code += `add x0, x0, #8\n`;
				emit_malloc(status);
				status.code += `str x0, [x29, #${offset}]\n`;
				status.code += `ldr x9, [x29, #${offset}]\n`;
				status.code += `mov x0, #${count}\n`;
				status.code += `str x0, [x9]\n`;
				for (let i = 0; i < count; i++) {
					const slot = 8 + i * element_size;
					// Source stack array: `emit_var_address(src)` is the DATA
					// area (length prefix at [src-8]), so elements are at
					// [&src + i*size].
					emit_var_address(status, "x0", src_name);
					if (element_size === 1) {
						status.code += `ldrb w0, [x0, #${i * element_size}]\n`;
					} else if (element_size === 4) {
						status.code += `ldr w0, [x0, #${i * element_size}]\n`;
					} else {
						status.code += `ldr x0, [x0, #${i * element_size}]\n`;
					}
					status.code += `ldr x9, [x29, #${offset}]\n`;
					status.code += `str x0, [x9, #${slot}]\n`;
				}
			} else {
				emit_data(status, `${node.name}: .space 8\n.p2align 2\n`);
				status.code += `mov x0, #${count}\n`;
				status.code += `mov x1, #${element_size}\n`;
				status.code += `mul x0, x0, x1\n`;
				status.code += `add x0, x0, #8\n`;
				emit_malloc(status);
				status.code += `adr x1, ${node.name}\n`;
				status.code += `str x0, [x1]\n`;
				status.code += `ldr x9, [x1]\n`;
				status.code += `mov x0, #${count}\n`;
				status.code += `str x0, [x9]\n`;
				for (let i = 0; i < count; i++) {
					const slot = 8 + i * element_size;
					emit_var_address(status, "x0", src_name);
					if (element_size === 1) {
						status.code += `ldrb w0, [x0, #${i * element_size}]\n`;
					} else if (element_size === 4) {
						status.code += `ldr w0, [x0, #${i * element_size}]\n`;
					} else {
						status.code += `ldr x0, [x0, #${i * element_size}]\n`;
					}
					status.code += `ldr x9, [${node.name}]\n`;
					status.code += `str x0, [x9, #${slot}]\n`;
				}
			}
			return;
		}
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
								emit_int_immediate(status, raw);
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
								if (element_size === 1) {
									status.code += `strb w0, [x29, #${slot_offset}]\n`;
								} else if (element_size === 4) {
									status.code += `str w0, [x29, #${slot_offset}]\n`;
								} else {
									status.code += `str x0, [x29, #${slot_offset}]\n`;
								}
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
								if (element_size === 1) {
									status.code += `strb w0, [${node.name} + ${i * element_size}]\n`;
								} else if (element_size === 4) {
									status.code += `str w0, [${node.name} + ${i * element_size}]\n`;
								} else {
									status.code += `str x0, [${node.name} + ${i * element_size}]\n`;
								}
							} else {
								build_node(value, status);
								if (!status.code.endsWith("\n")) {
									status.code += "\n";
								}
								if (element_size === 1) {
									status.code += `strb w0, [${node.name} + ${i * element_size}]\n`;
								} else if (element_size === 4) {
									status.code += `str w0, [${node.name} + ${i * element_size}]\n`;
								} else {
									status.code += `str x0, [${node.name} + ${i * element_size}]\n`;
								}
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
						emit_int_immediate(status, raw);
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
		} else if (
			node.value &&
			(node.value.node_type === "func_call" ||
				(node.value.node_type === "access" &&
					(node.value as AccessNode).access.node_type === "access_func"))
		) {
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
					// Anchor the instance so it's freed at scope exit. For
					// argument temporaries (_param_N) passed via `mov`, the
					// callee takes ownership and mark_moved_if_struct adds
					// them to status.moved — the cleanup paths (both decl
					// and heap_slots) skip moved vars, so no double-free.
					anchor_heap_pointer(status, node.name, undefined, node.type.is_nullable);
					status.code += `str x0, [x29, #${status.stack_offsets!.get(node.name)}]\n`;
					const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
					const outgoing = build_constructor_params(func_call, param_regs, status);
					emit_var_load(status, "x0", node.name, 8);
					status.code += `bl ${func_call.name}_init\n`;
					if (outgoing > 0) status.code += `add sp, sp, #${outgoing}\n`;
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
					// A free function (non-constructor) returning a class hands the
					// caller a fresh owned instance (e.g. VStack/HStack/Grid/ZStack
					// → Container). Force the heap flag so `check_heap` anchors the
					// result for scope-exit cleanup. Without this, a forward-
					// referenced library factory leaks: main is built before the
					// library, so the callee isn't in `heap_returning_functions` at
					// the call site and `last_result_is_heap` stays false. A free-
					// function call returning a class is always an owned result, so
					// anchoring unconditionally here is sound (user-space factories
					// already set the flag, so this only changes the forward-ref
					// case — no double-anchor).
					status.last_result_is_heap = true;
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
				// A captured `spawn` expression allocates a Task on the heap;
				// anchor it so it's freed at scope exit. (Statement-form
				// spawns never reach a declaration.)
				if (node.value.node_type === "spawn") {
					anchor_heap_pointer(status, node.name);
				}
				emit_var_store(status, "x0", node.name, 8);
			}
		} else {
			// Struct declaration
			const nullable_struct = is_nullable_struct_type(node.type, status);
			const struct_size = get_struct_size(resolved_struct_name, status);
			const total_size = nullable_struct ? struct_size + 8 : struct_size;
			if (status.function_return_label) {
				const offset = allocate_stack_space(status, total_size);
				status.stack_offsets!.set(node.name, offset);
				if (nullable_struct) {
					status.stack_offsets!.set(has_flag_name(node.name), offset + struct_size);
				}
			} else {
				emit_data(status, `${node.name}: .space ${total_size}\n`);
				if (nullable_struct) {
					status.stack_offsets!.set(has_flag_name(node.name), -1);
				}
			}
			// Initialize the companion flag for a nullable struct local:
			// 0 for null/unset, 1 when a real value is assigned below — EXCEPT
			// when the value comes from a function call returning a nullable
			// struct: the callee writes both the struct value AND the flag through
			// the sret buffer (x8 = &local), so hardcoding `1` here would clobber
			// the real null/non-null bit the callee wrote.
			if (nullable_struct) {
				const is_null_init =
					!node.value ||
					(node.value.node_type === "value" && (node.value as ValueNode).value === "null");
				const value_is_nullable_call =
					!!node.value &&
					node.value.node_type === "func_call" &&
					is_nullable_struct_type((node.value as FunctionCallNode).type, status);
				const flag_off = status.stack_offsets!.get(has_flag_name(node.name));
				if (status.function_return_label && flag_off !== undefined && flag_off >= 0) {
					status.code += `str xzr, [x29, #${flag_off}]\n`;
					// Skip the hardcoded `1` for nullable-call initializers — the
					// callee writes the real flag through the sret buffer.
					if (!is_null_init && !value_is_nullable_call) {
						status.code += `mov x9, #1\n`;
						status.code += `str x9, [x29, #${flag_off}]\n`;
					}
				}
				// For a null initializer, the flag is 0 and there's no value to
				// copy — skip the generic struct-value copy path below (it would
				// try to copy bytes from the `null` literal).
				if (is_null_init) {
					return;
				}
			}
			if (node.value && node.value.node_type === "func_call") {
				const func_call = node.value as FunctionCallNode;
				const is_constructor = status.structs.find(
					(s) => s.name === func_call.name && !s.is_simple_type,
				);
				if (is_constructor) {
					// Evaluate params into x1-x7 first (before setting x0)
					const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
					const outgoing = build_constructor_params(func_call, param_regs, status);
					// Pass declaration address in x0
					emit_var_address(status, "x0", node.name);
					status.code += `bl ${func_call.name}_init\n`;
					if (outgoing > 0) status.code += `add sp, sp, #${outgoing}\n`;
					if (func_call.mov_param_indices?.length) {
						for (const idx of func_call.mov_param_indices) {
							mark_moved_if_struct(func_call.params[idx], status);
						}
					}
					build_swap_params(func_call, status);
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
				}
			} else if (node.value) {
				if (node.value.node_type === "value") {
					const src_name = (node.value as ValueNode).value;
					emit_var_address(status, "x1", src_name);
				} else {
					// For a struct-typed source (e.g. a field access `self.funds`),
					// copy from the source's ADDRESS, not its value — build_node
					// would load the first word. emit_address_of yields the lvalue
					// address for accesses; other struct expressions build to an
					// address in x0 already.
					const src_is_struct = is_struct_type_node(node.value, status);
					if (src_is_struct && node.value.node_type === "access") {
						emit_address_of(node.value, status);
					} else if (src_is_struct) {
						get_source_address(node.value, status);
					} else {
						build_node(node.value, status);
					}
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
				// `var X b = mov a`: the bytes are copied into b, then the source is
				// marked moved so it is not destroyed at scope exit (b is now the sole
				// owner). Without this, both a and b would free the same backing data.
				if (node.value.is_moved) {
					mark_moved_if_struct(node.value, status);
				}
				// `var X b = mov obj.field swap <rep>`: the field's bytes were copied
				// into b above; now struct-copy the replacement back into the moved-out
				// field to revalidate it (so the owner never destroys a moved field).
				if (node.swap && node.value.node_type === "access") {
					const access = node.value as AccessNode;
					build_node(node.swap, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					status.code += `str x0, [sp, #-16]!\n`;
					emit_address_of(access.target, status);
					if (!status.code.endsWith("\n")) {
						status.code += "\n";
					}
					status.code += `ldr x1, [sp], #16\n`;
					const field_name = (access.access as AccessFieldNode).name;
					const target_type = type_from_value_node(access.target);
					const field_type = type_from_value_node(access.access);
					const offset = get_field_offset(target_type.name, field_name, status);
					const field_size = get_struct_size(field_type.name, status);
					emit_struct_copy("x1", "x0", offset, field_size, status);
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
					const label = `_float_const_${decl_const_counter++}`;
					emit_data(status, `${label}: .double ${raw}\n.p2align 2\n`);
					status.code += `adr x0, ${label}\n`;
					status.code += `ldr d0, [x0]\n`;
					status.code += `str d0, [x29, #${offset}]\n`;
				} else if (node.type.name === "string" && raw.startsWith('"')) {
					if (status.force_heap_strings?.has(node.name)) {
						const label = `_str_init_${decl_const_counter++}`;
						emit_data(status, `${label}: .asciz ${escape_asciz(raw)}\n.p2align 2\n`);
						status.code += `adr x0, ${label}\n`;
						emit_strdup(status);
						status.code += `str x0, [x29, #${offset}]\n`;
						mark_heap_string(status, node.name);
					} else {
						const label = `_str_init_${decl_const_counter++}`;
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
								emit_int_immediate(status, raw);
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
	// Named-field struct literal overrides (e.g. `[ grow = 2 ]` on a struct
	// whose `grow` field has a declared default) are applied as post-
	// construction field assignments after the constructor returned. The
	// synthetic AssignmentNodes reuse the existing assignment build path.
	if (node.value?.node_type === "func_call") {
		emit_field_overrides(node.name, node.value, build_node, status);
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

/** The decimal element values of a static range (`1..4` → ["1","2","3"]), or
 *  `undefined` for a dynamic (runtime-bound) range. */
function range_to_values(node: RangeNode): string[] | undefined {
	const s = evaluate_range_static(node);
	if (s === null) return undefined;
	return s === "" ? [] : s.split(", ");
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
