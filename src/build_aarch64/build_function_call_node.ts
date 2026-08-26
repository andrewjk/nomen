import emit_field_overrides from "../build/emit_field_overrides.ts";
import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { has_flag_name, is_nullable_struct_type } from "../build_common/nullable_struct.ts";
import string_literal_length from "../build_common/string_literal_length.ts";
import { is_float_type } from "../built_in_types.ts";
import { is_int_literal, to_decimal_string } from "../int_literal.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { emit_address_of } from "./build_access_node.ts";
import { build_inline_function } from "./build_inline_method.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_malloc } from "./utils/audit.ts";
import { all_scope_frames, mark_moved_if_struct, find_anchor_slot } from "./utils/auto_destroy.ts";
import { build_swap_params } from "./utils/build_swap.ts";
import { find_enum_for_case } from "./utils/enum_case.ts";
import { NUM_REG_ARGS } from "./utils/stack_args.ts";
import {
	allocate_stack_space,
	emit_deref_var_address,
	emit_var_address,
	emit_var_load,
	is_local_ref_var,
} from "./utils/stack_var.ts";
import { emit_strdup_string } from "./utils/string_pair.ts";
import { get_enum_size, get_struct_size } from "./utils/struct_layout.ts";
import { emit_view_string_arg } from "./utils/view_value.ts";

let temp_counter = 0;

export function reset_temp_counter() {
	temp_counter = 0;
	array_param_counter = 0;
}

function is_struct_type(type_name: string, status: BuildStatus): boolean {
	return !!status.structs.find((s) => s.name === type_name && !s.is_simple_type);
}

function is_enum_with_data_type(type_name: string, status: BuildStatus): boolean {
	const e = status.enums.find((e) => e.name === type_name);
	return !!e && !!e.has_associated_data;
}

// Forward a `ref` class PARAM to another `ref` param. The param's
// callee-saved register holds the instance, but the ADDRESS of the caller's
// pointer slot — what the callee dereferences at entry and writes back through
// on reassignment — lives in `ref_class_slots[name]`. Load that slot address
// into x0 and record the name so its register can be reloaded post-call.
function emit_ref_class_param_slot(
	status: BuildStatus,
	ref_param_slot: number,
	name: string,
	reload: string[],
) {
	status.code += `ldr x0, [x29, #${ref_param_slot}]\n`;
	reload.push(name);
}

function get_raw_value(node: ValueNode, status?: BuildStatus): string {
	let val = node.value;
	if (val === "true") return "1";
	if (val === "false") return "0";
	if (node.is_enum_shorthand && status) {
		const found = find_enum_for_case(val, status);
		if (found) {
			const case_index = found.enum_node.cases.findIndex((c) => c.name === found.case_name);
			if (case_index >= 0) return String(case_index);
		}
	}
	if (is_int_literal(val)) return to_decimal_string(val);
	return val;
}

let array_param_counter = 0;

function emit_struct_address(node: BaseNode, status: BuildStatus) {
	if (node.node_type === "value") {
		const name = (node as any).value;
		// A bare enum-shorthand case value (`.none`, rewritten to
		// `Enum_case`) is not a variable — build it, which leaves the address
		// of a tag+payload temp in x0 for enums with associated data.
		if ((node as ValueNode).is_enum_shorthand) {
			const found = find_enum_for_case(name, status);
			if (found?.enum_node.has_associated_data) {
				build_node(node, status);
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				return;
			}
		}
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
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}
}

/**
 * Whether an argument expression is a fat string VALUE: either its static
 * type names `string`, or it is a string literal (whose ValueNode.type may
 * be unset). Literals ride the pair ABI like any string.
 */
function arg_is_string(node: BaseNode): boolean {
	const v = node as { value?: string };
	if (node.node_type === "value" && typeof v.value === "string" && v.value.startsWith('"')) {
		return true;
	}
	const t = type_from_value_node(node);
	return t?.name === "string" && !t.is_view && !t.is_array;
}

export default function build_function_call_node(node: FunctionCallNode, status: BuildStatus) {
	// Shorthand enum-with-args constructor `.case(args)` (rewritten by the
	// checker to `Enum_case` with is_enum_shorthand=true). Allocate a tag+payload
	// temp, store the case index at +0, then each arg at its payload offset.
	// Mirrors the AccessFunctionCallNode path in build_access_node.
	if (node.is_enum_shorthand && node.params.length > 0) {
		const found = find_enum_for_case(node.name, status);
		if (found && found.enum_node.has_associated_data) {
			const enum_node = found.enum_node;
			const case_name = found.case_name;
			const enum_case = enum_node.cases.find((c) => c.name === case_name);
			if (enum_case) {
				const case_index = enum_node.cases.indexOf(enum_case);
				const enum_size = get_enum_size(enum_node.name, status);
				const temp_offset = allocate_stack_space(status, enum_size);
				status.code += `add x0, x29, #${temp_offset}\n`;
				status.code += `mov x1, #${case_index}\n`;
				status.code += `str x1, [x0]\n`;
				let payload_offset = 8;
				for (let i = node.params.length - 1; i >= 0; i--) {
					build_node(node.params[i], status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					const param_type_name = enum_case.params[i].type.name;
					const param_size = aarch64_size(param_type_name);
					const abs_offset = temp_offset + payload_offset;
					if (param_type_name === "string") {
						// A string payload is an OWNED copy: strdup the (ptr,
						// len) pair the arg built, then store both halves —
						// the enum value outlives the producer's local, and
						// the scope-exit payload free needs a heap ptr.
						emit_strdup_string(status);
						status.code += `str x0, [x29, #${abs_offset}]\n`;
						status.code += `str x1, [x29, #${abs_offset + 8}]\n`;
					} else if (param_size === 1) {
						status.code += `strb w0, [x29, #${abs_offset}]\n`;
					} else if (param_size === 4) {
						status.code += `str w0, [x29, #${abs_offset}]\n`;
					} else {
						status.code += `str x0, [x29, #${abs_offset}]\n`;
					}
					payload_offset += param_size;
				}
				status.code += `add x0, x29, #${temp_offset}\n`;
				build_swap_params(node, status);
				return;
			}
		}
	}

	const is_struct = status.structs.find((s) => s.name === node.name && !s.is_simple_type);
	const func_name = is_struct ? `${node.name}_init` : node.name;
	const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];

	let start_reg = 0;

	if (is_struct) {
		if (is_struct.is_class) {
			const struct_size = get_struct_size(node.name, status);
			status.code += `mov x0, #${struct_size}\n`;
			emit_malloc(status);
			status.code += `str x0, [sp, #-16]!\n`;
		} else if (status.struct_return_buffer) {
			// Reload the incoming sret pointer from its frame slot: x8 is
			// destructible (AAPCS64), so intervening calls in this body may
			// have clobbered the live register. The prologue spilled it.
			if (status.return_buffer_stack_offset !== undefined) {
				status.code += `ldr x8, [x29, #${status.return_buffer_stack_offset}]\n`;
			}
			status.code += `mov x0, ${status.struct_return_buffer}\n`;
		} else {
			const dest_addr = `_temp_${temp_counter++}`;
			const struct_size = get_struct_size(node.name, status);
			const offset = allocate_stack_space(status, struct_size);
			status.stack_offsets!.set(dest_addr, offset);
			// Register the temp's type so field overrides applied to it
			// (e.g. `f(T() + [ field = v ])`) resolve field offsets correctly.
			if (!status.variable_types) status.variable_types = new Map();
			status.variable_types.set(dest_addr, node.type);
		}
		start_reg = 1;
	}

	if (node.is_func_param) {
		// Load function pointer from stack
		const func_offset = status.stack_offsets?.get(node.name);
		if (func_offset !== undefined) {
			status.code += `ldr x8, [x29, #${func_offset}]\n`;
		} else {
			const paramReg = status.function_param_regs?.get(node.name);
			if (paramReg) {
				status.code += `mov x8, ${paramReg}\n`;
			} else {
				status.code += `adr x8, ${node.name}\n`;
			}
		}

		// Evaluate params right-to-left
		for (let i = node.params.length - 1; i >= 0; i--) {
			build_node(node.params[i], status);
			const reg = param_regs[start_reg + i];
			if (reg !== "x0") {
				status.code += `\nmov ${reg}, x0\n`;
			} else {
				status.code += `\n`;
			}
		}

		status.code += `blr x8\n`;
	} else {
		const variadic_idx = (node as FunctionCallNode).variadic_param_index;
		// Collect `ref` class args whose caller-side anchor must be re-synced to
		// the (possibly reassigned) slot value after the call returns.
		const ref_class_sync_names: string[] = [];
		// Collect `ref` class PARAMS forwarded to another `ref` param. The
		// callee may have reassigned the caller's slot, so the param's
		// callee-saved register (which still holds the pre-call instance) must
		// be reloaded from the slot once the call returns.
		const ref_class_param_reload: string[] = [];

		// Outgoing stack-arg area size (0 unless this call passes more args
		// than fit in x0..x7). Set below for both the non-variadic and the
		// variadic-tuple paths (the latter counts the hidden count/ptr pair).
		let outgoing_size = 0;
		let overflow_count = 0;

		if (variadic_idx !== undefined) {
			// Variadic call: pack variadic args into a stack array
			const arr = node.params[variadic_idx] as ArrayValuesNode;
			const elem_type_name = arr.type.name || "int";
			const elem_struct = status.structs.find(
				(s) => s.name === elem_type_name && !s.is_simple_type,
			);
			// A fat `string` element is a 16-byte { ptr, len } slot even
			// though `string` has no struct node (which would size it at 8).
			const elem_is_string = elem_type_name === "string";
			const elem_size = elem_struct
				? get_struct_size(elem_type_name, status)
				: elem_is_string
					? 16
					: 8;
			// Pack behind an 8-byte length prefix so the buffer carries the
			// standard aarch64 array layout (first-element pointer, length at
			// [-8]): array method bodies — raw #arch (at_end) and Nomen-level
			// (at_or) alike — read the length at [self - 8] when a variadic
			// param is the receiver. Always reserve at least one element so
			// the pointer passed is a valid, uniquely-owned stack address
			// even when there are zero variadic args.
			const arr_offset = allocate_stack_space(
				status,
				8 + Math.max(arr.values.length, 1) * elem_size,
				16,
			);
			const data_base = arr_offset + 8;
			status.code += `mov x0, #${arr.values.length}\n`;
			status.code += `str x0, [x29, #${arr_offset}]\n`;

			// Evaluate all variadic args and store on stack
			for (let j = arr.values.length - 1; j >= 0; j--) {
				const arg = arr.values[j];
				const slot_offset = data_base + j * elem_size;
				if (elem_struct && arg.node_type === "func_call") {
					// Tuple constructor: evaluate params into x1..x7 (right-to-left)
					// then set x0 to slot address and call _init. A by-value
					// string param consumes TWO consecutive registers (ptr, len) —
					// matching _init's pair prologue — so compute a slot map
					// left-to-right before packing.
					const fc = arg as FunctionCallNode;
					const fc_param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
					const fc_slots: number[] = [];
					let fc_total = 0;
					for (let k = 0; k < fc.params.length; k++) {
						fc_slots.push(fc_total);
						fc_total += arg_is_string(fc.params[k]) ? 2 : 1;
					}
					for (let k = fc.params.length - 1; k >= 0; k--) {
						build_node(fc.params[k], status);
						if (!status.code.endsWith("\n")) status.code += "\n";
						const reg_idx = fc_slots[k];
						if (arg_is_string(fc.params[k]) && reg_idx + 1 < fc_param_regs.length) {
							// Move the LEN half FIRST: the pair rides in x0/x1,
							// and for slot 0 the ptr destination IS x1 — moving
							// it first would destroy the length.
							status.code += `mov ${fc_param_regs[reg_idx + 1]}, x1\n`;
							status.code += `mov ${fc_param_regs[reg_idx]}, x0\n`;
						} else {
							status.code += `mov ${fc_param_regs[reg_idx]}, x0\n`;
						}
					}
					status.code += `add x0, x29, #${slot_offset}\n`;
					status.code += `bl ${fc.name}_init\n`;
				} else if (elem_struct) {
					// Struct value: copy from where it lives into the slot
					emit_struct_address(arg, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `mov x1, x0\n`;
					status.code += `add x0, x29, #${slot_offset}\n`;
					for (let b = 0; b < elem_size; b += 8) {
						status.code += `ldr x2, [x1, #${b}]\n`;
						status.code += `str x2, [x0, #${b}]\n`;
					}
				} else if (elem_is_string) {
					// Fat string element: store both (ptr, len) halves.
					build_node(arr.values[j], status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `str x0, [x29, #${slot_offset}]\n`;
					status.code += `str x1, [x29, #${slot_offset + 8}]\n`;
				} else {
					build_node(arr.values[j], status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `str x0, [x29, #${slot_offset}]\n`;
				}
			}

			// Evaluate non-variadic params right-to-left (they come after variadic in the call)
			const non_variadic: {
				node: BaseNode;
				is_struct: boolean;
				is_ref: boolean;
				is_view: boolean;
			}[] = [];
			for (let i = 0; i < node.params.length; i++) {
				if (i === variadic_idx) continue;
				const param = node.params[i];
				const param_type = (param as any).type?.name || "";
				const is_ref_param = node.ref_param_indices?.includes(i);
				non_variadic.push({
					node: param,
					is_struct:
						is_struct_type(param_type, status) || is_enum_with_data_type(param_type, status),
					is_ref: !!is_ref_param,
					is_view: !!node.view_param_indices?.includes(i),
				});
			}
			// The non-variadic params plus the hidden (count, pointer) pair
			// occupy consecutive AAPCS64 register/stack slots: the
			// non-variadic params first (a `view` param takes TWO — the
			// (ptr, len) pair), then the count and the array pointer. When
			// the total exceeds the 8 register slots the surplus overflows
			// into the caller's outgoing stack area, so mirror the
			// non-variadic path: spill every slot to a dedicated area first
			// (evaluating an arg can clobber any register), then load the
			// in-register slots and copy the overflow slots to the outgoing
			// area below `sp`.
			const nv = non_variadic.length;
			const nv_slot: number[] = [];
			let nv_total = 0;
			for (let i = 0; i < nv; i++) {
				nv_slot.push(nv_total);
				nv_total += non_variadic[i].is_view ? 2 : 1;
			}
			const total_slots = nv_total + 2;
			const slots_base = allocate_stack_space(status, total_slots * 8, 16);
			const count_slot = slots_base + nv_total * 8;
			const ptr_slot = count_slot + 8;

			// Evaluate non-variadic params right-to-left, spilling each to
			// its slot.
			for (let i = nv - 1; i >= 0; i--) {
				const ep = non_variadic[i];
				if (ep.is_view) {
					emit_view_string_arg(ep.node, status);
					status.code += `str x0, [x29, #${slots_base + nv_slot[i] * 8}]\n`;
					status.code += `str x1, [x29, #${slots_base + (nv_slot[i] + 1) * 8}]\n`;
					continue;
				}
				if (ep.is_struct) {
					emit_struct_address(ep.node, status);
				} else if (ep.is_ref) {
					const ep_name = ep.node.node_type === "value" ? (ep.node as ValueNode).value : undefined;
					const ref_param_slot =
						ep_name !== undefined ? status.ref_class_slots?.get(ep_name) : undefined;
					if (ref_param_slot !== undefined) {
						emit_ref_class_param_slot(status, ref_param_slot, ep_name!, ref_class_param_reload);
					} else {
						emit_address_of(ep.node, status);
					}
				} else {
					build_node(ep.node, status);
				}
				if (!status.code.endsWith("\n")) status.code += "\n";
				status.code += `str x0, [x29, #${slots_base + nv_slot[i] * 8}]\n`;
			}

			// Store the count and array pointer into their slots.
			status.code += `mov x0, #${arr.values.length}\n`;
			status.code += `str x0, [x29, #${count_slot}]\n`;
			status.code += `add x0, x29, #${data_base}\n`;
			status.code += `str x0, [x29, #${ptr_slot}]\n`;

			// Load each in-register slot into its argument register. Slot 0
			// maps to x0 unless this is a struct-constructor call (x0 is the
			// destination pointer, set up below); overflow slots are skipped
			// here and copied to the outgoing area below.
			for (let s = 0; s < total_slots; s++) {
				const slot = start_reg + s;
				if (slot >= NUM_REG_ARGS) continue;
				const reg = param_regs[slot];
				if (reg === "x0") continue;
				status.code += `ldr ${reg}, [x29, #${slots_base + s * 8}]\n`;
			}
			if (start_reg === 0) {
				status.code += `ldr x0, [x29, #${slots_base}]\n`;
			}

			// AAPCS64: slots past x0..x7 go in the caller's outgoing area at
			// [sp] at the moment of the bl. Lower sp, copy each overflow slot
			// down; sp is restored after the call (handled below).
			overflow_count = Math.max(0, total_slots - (NUM_REG_ARGS - start_reg));
			if (overflow_count > 0) {
				outgoing_size = Math.ceil((overflow_count * 8) / 16) * 16;
				status.code += `sub sp, sp, #${outgoing_size}\n`;
				const overflow_first = NUM_REG_ARGS - start_reg;
				for (let k = 0; k < overflow_count; k++) {
					status.code += `ldr x9, [x29, #${slots_base + (overflow_first + k) * 8}]\n`;
					status.code += `str x9, [sp, #${k * 8}]\n`;
				}
			}
		} else {
			// Non-variadic call.
			// A `view T` param (view_param_indices) consumes TWO consecutive
			// argument slots — (ptr, len) — matching the callee prologue's
			// pair spilling. So does a fat `string` param. Compute a slot
			// map first so spills, register loads, and the overflow area all
			// agree.
			const view_arg_set = new Set(node.view_param_indices ?? []);
			const string_arg_set = new Set<number>();
			// A fat `string` ARGUMENT consumes two slots — detection is by
			// the argument's static type, which stays correct even when the
			// callee signature is still generic. Interpolation helpers take
			// fat strings too (pattern + rendered args).
			const is_interp_call = node.name.startsWith("_string_interpolate_");
			for (let i = 0; i < node.params.length; i++) {
				if (!is_interp_call && (node.ref_param_indices ?? []).includes(i)) continue;
				if (is_interp_call || arg_is_string(node.params[i])) {
					string_arg_set.add(i);
				}
			}
			const arg_slot: number[] = [];
			let total_slots = 0;
			for (let i = 0; i < node.params.length; i++) {
				arg_slot.push(total_slots);
				total_slots += view_arg_set.has(i) || string_arg_set.has(i) ? 2 : 1;
			}
			// Evaluate each param into x0 (and x1 for a view pair) and spill
			// it to a dedicated stack slot, then load all slots into argument
			// registers right before the call. Evaluating an argument
			// expression can use x1..x7 as scratch (e.g. binary operators
			// hardcode x1/x2), so storing a result directly into its target
			// register would let a later argument clobber an earlier one
			// (e.g. `[a+1, a+2]` lost the second value).
			const has_args = total_slots > 0;
			let args_base = 0;
			if (has_args) {
				args_base = allocate_stack_space(status, total_slots * 8, 16);
			}
			// Evaluate params right-to-left, spilling each result to its slot.
			for (let i = node.params.length - 1; i >= 0; i--) {
				const param = node.params[i];
				const param_type = (param as any).type?.name || "";
				const is_ref_param = node.ref_param_indices?.includes(i);
				// A `view string` argument passes as a (ptr, len) pair in
				// x0/x1 — a view VALUE passes through, an owned string is
				// wrapped with its strlen (the caller keeps ownership).
				if (view_arg_set.has(i)) {
					emit_view_string_arg(param, status);
					status.code += `str x0, [x29, #${args_base + arg_slot[i] * 8}]\n`;
					status.code += `str x1, [x29, #${args_base + (arg_slot[i] + 1) * 8}]\n`;
					continue;
				}
				// A fat `string` argument is already the (ptr, len) pair in
				// x0/x1 — spill both halves.
				if (string_arg_set.has(i)) {
					build_node(param, status);
					if (!status.code.endsWith("\n")) status.code += "\n";
					status.code += `str x0, [x29, #${args_base + arg_slot[i] * 8}]\n`;
					status.code += `str x1, [x29, #${args_base + (arg_slot[i] + 1) * 8}]\n`;
					continue;
				}
				// An `Array<T>` argument that is itself a heap-array value (a
				// `heap_array_vars` local or an `Array<T>` param — both already
				// `struct Array_<T>*` pointers) must be forwarded directly
				// regardless of `ref`/non-`ref`: `.set` mutates in place
				// through the pointer, so neither `emit_address_of` (which
				// would pass `&slot`, a double pointer) nor a deref is wanted.
				const arr_arg_name = param.node_type === "value" ? (param as ValueNode).value : undefined;
				const arg_is_array_struct_val =
					!!arr_arg_name && !!status.heap_array_vars?.has(arr_arg_name);
				if (arg_is_array_struct_val) {
					build_node(param, status);
				} else if (param.node_type === "array" && param_type) {
					const arr = param as ArrayValuesNode;
					const label = `_arr_param_${array_param_counter++}`;
					const has_strings = arr.values.some(
						(v) => v.node_type === "value" && (v as ValueNode).value.startsWith('"'),
					);
					if (has_strings) {
						// Fat-string rows: each element is TWO quads (ptr label,
						// compile-time len) — 16 bytes, matching the callee's
						// string-element stride.
						const str_labels: (string | null)[] = [];
						arr.values.forEach((v, idx) => {
							if (v.node_type === "value" && (v as ValueNode).value.startsWith('"')) {
								const str_label = `_arr_str_${array_param_counter++}_${idx}`;
								status.code += `${str_label}: .asciz ${(v as ValueNode).value}\n.p2align 2\n`;
								str_labels.push(str_label);
							} else {
								str_labels.push(null);
							}
						});
						const row = arr.values
							.map((v, idx) => {
								const lbl = str_labels[idx];
								if (lbl) {
									return `.quad ${lbl}\n\t.quad ${string_literal_length((v as ValueNode).value)}`;
								}
								const raw = v.node_type === "value" ? get_raw_value(v as ValueNode, status) : "0";
								return `.quad ${raw}\n\t.quad 0`;
							})
							.join(", ");
						status.code += `${label}: ${row}\n.p2align 2\n`;
					} else {
						const values = arr.values
							.map((v) => (v.node_type === "value" ? get_raw_value(v as ValueNode, status) : "0"))
							.join(", ");
						status.code += `${label}: .quad ${values}\n.p2align 2\n`;
					}
					status.code += `adr x0, ${label}`;
				} else if (is_ref_param) {
					// A `ref` arg must pass the ADDRESS of the caller's slot so the
					// callee can reassign it. A CLASS local's slot holds the heap
					// pointer (it is an is_local_ref_var), so emit_address_of would
					// dereference it — pass the raw slot address instead so the
					// callee can store a new pointer back through it. A struct ref
					// local (e.g. `var ref Point p = a`) also is_local_ref_var, but
					// its slot holds a pointer to a struct that lives elsewhere; for
					// it the existing dereference (the struct's address) is correct,
					// so only divert class locals here. A `ref` class PARAM is
					// neither: its callee-saved register holds the instance while
					// the caller's slot address lives in ref_class_slots — pass that
					// slot address (otherwise the callee dereferences the instance
					// pointer and corrupts memory).
					const arg = node.params[i];
					const arg_name = arg.node_type === "value" ? (arg as ValueNode).value : undefined;
					let arg_is_class = false;
					if (arg_name) {
						const tn = (arg as any).type?.name ?? status.variable_types?.get(arg_name)?.name;
						arg_is_class = !!tn && !!status.structs.find((s) => s.name === tn && s.is_class);
					}
					const ref_param_slot =
						arg_name !== undefined ? status.ref_class_slots?.get(arg_name) : undefined;
					if (ref_param_slot !== undefined) {
						emit_ref_class_param_slot(status, ref_param_slot, arg_name!, ref_class_param_reload);
					} else if (arg_name !== undefined && is_local_ref_var(arg_name, status) && arg_is_class) {
						emit_var_address(status, "x0", arg_name);
						ref_class_sync_names.push(arg_name);
					} else {
						emit_address_of(arg, status);
					}
				} else if (node.nullable_param_indices?.includes(i)) {
					// A nullable struct value parameter (`T? p`) needs combined
					// `[struct | flag]` storage at the call site so the callee
					// can read the flag at `[param_ptr + struct_size]`. Handle
					// each arg shape:
					//   - bare nullable-struct VARIABLE: address of its combined
					//     storage (the local reserves `struct_size + 8`).
					//   - `null` literal: a zero'd region (flag = 0).
					//   - non-null rvalue (constructor, call, etc.): materialise
					//     into a combined region with value + flag = 1.
					const arg = node.params[i];
					const struct_size = get_struct_size(param_type, status);
					if (arg.node_type === "value" && (arg as ValueNode).value === "null") {
						// `null` arg: allocate combined storage and zero the
						// FLAG slot (at `[off + struct_size]`). The struct
						// value bytes are left uninitialised — the callee
						// won't read them when the flag is 0.
						const off = allocate_stack_space(status, struct_size + 8);
						status.code += `str xzr, [x29, #${off + struct_size}]\n`;
						status.code += `add x0, x29, #${off}\n`;
					} else if (
						arg.node_type === "value" &&
						is_nullable_struct_type((arg as ValueNode).type, status)
					) {
						// Bare nullable variable — its storage is already
						// combined; just take its address.
						emit_var_address(status, "x0", (arg as ValueNode).value);
					} else {
						// Non-null rvalue: build the value (lands as address in
						// x0 for a struct rvalue, since emit_struct_address /
						// build_node for a struct leaves the temp's address).
						emit_struct_address(arg, status);
						if (!status.code.endsWith("\n")) status.code += "\n";
						const off = allocate_stack_space(status, struct_size + 8);
						// Copy the struct value word-by-word, set flag = 1.
						for (let b = 0; b < struct_size; b += 8) {
							status.code += `ldr x9, [x0, #${b}]\n`;
							status.code += `str x9, [x29, #${off + b}]\n`;
						}
						status.code += `mov x9, #1\n`;
						status.code += `str x9, [x29, #${off + struct_size}]\n`;
						status.code += `add x0, x29, #${off}\n`;
					}
				} else if (
					is_struct_type(param_type, status) ||
					is_enum_with_data_type(param_type, status)
				) {
					emit_struct_address(node.params[i], status);
				} else {
					build_node(node.params[i], status);
				}
				if (!status.code.endsWith("\n")) {
					status.code += "\n";
				}
				status.code += `str x0, [x29, #${args_base + arg_slot[i] * 8}]\n`;
			}

			// Load each spilled argument into its target register. For struct
			// constructors x0 is the destination (set up below), so it's never a
			// param target; for ordinary calls param 0 goes in x0. Arguments
			// beyond the 8 register slots are spilled to the outgoing stack-arg
			// area below, not to a register. Slot indices (not param indices)
			// drive the mapping — a view arg occupies two consecutive slots.
			if (has_args) {
				for (let s = 0; s < total_slots; s++) {
					const slot = start_reg + s;
					if (slot >= NUM_REG_ARGS) continue;
					const reg = param_regs[slot];
					if (reg === "x0") continue;
					status.code += `ldr ${reg}, [x29, #${args_base + s * 8}]\n`;
				}
				if (!is_struct) {
					status.code += `ldr x0, [x29, #${args_base}]\n`;
				}
			}
			// AAPCS64: arguments past x0..x7 go in the caller's outgoing area,
			// which must be at [sp] at the moment of the bl. Lower sp by the
			// outgoing area size and copy each overflow arg from its spill slot
			// into the outgoing area; restore sp right after the call. Skip
			// when there's no overflow (the common case).
			overflow_count = Math.max(0, total_slots - (NUM_REG_ARGS - start_reg));
			if (overflow_count > 0) {
				outgoing_size = Math.ceil((overflow_count * 8) / 16) * 16;
				status.code += `sub sp, sp, #${outgoing_size}\n`;
				const overflow_first = NUM_REG_ARGS - start_reg;
				for (let k = 0; k < overflow_count; k++) {
					status.code += `ldr x9, [x29, #${args_base + (overflow_first + k) * 8}]\n`;
					status.code += `str x9, [sp, #${k * 8}]\n`;
				}
			}
		}

		if (is_struct && status.struct_return_buffer) {
			// Reload the incoming sret pointer from its frame slot (see the
			// matching reload above): x8 may have been clobbered by any call
			// emitted between the prologue and here.
			if (status.return_buffer_stack_offset !== undefined) {
				status.code += `ldr x8, [x29, #${status.return_buffer_stack_offset}]\n`;
			}
			status.code += `mov x0, ${status.struct_return_buffer}\n`;
		} else if (is_struct && is_struct.is_class) {
			status.code += `ldr x0, [sp]\n`;
		} else if (is_struct && !is_struct.is_class) {
			const temp_addr = `_temp_${temp_counter - 1}`;
			const temp_offset = status.stack_offsets!.get(temp_addr)!;
			status.code += `add x0, x29, #${temp_offset}\n`;
		} else if (!is_struct && node.type?.name && !status.call_x8_preset) {
			const return_struct = status.structs.find(
				(s) => s.name === node.type!.name && !s.is_simple_type && !s.is_class,
			);
			if (return_struct) {
				// A nullable struct return's temp must hold both the struct value
				// AND its companion `_has` flag (struct_size + 8 bytes), so the
				// callee can write the null/non-null bit at [temp + struct_size].
				const nullable_ret = is_nullable_struct_type(node.type, status);
				const struct_size = get_struct_size(node.type!.name, status);
				const total = nullable_ret ? struct_size + 8 : struct_size;
				const temp_name = `_call_ret_${temp_counter++}`;
				const offset = allocate_stack_space(status, total);
				status.stack_offsets!.set(temp_name, offset);
				if (nullable_ret) {
					status.stack_offsets!.set(has_flag_name(temp_name), offset + struct_size);
				}
				// The callee copies its result through the incoming sret pointer,
				// so x8 MUST hold a valid destination here — even when the
				// ENCLOSING function itself returns a struct (its own sret
				// pointer is spilled in the frame and reloaded at its returns;
				// x8 currently holds caller-saved garbage). Only a pre-set
				// destination (call_x8_preset, a struct declaration
				// initialiser) suppresses this.
				status.code += `add x8, x29, #${offset}\n`;
			}
		}

		const inline_candidate = status.inline_functions?.get(func_name);
		// Inline candidates are small functions and don't expect > 8 params;
		// the inline path also can't accept a pre-lowered outgoing-arg area,
		// so disable inlining when this call has overflow args.
		if (
			inline_candidate &&
			(inline_candidate as any).node_type === "func" &&
			!is_struct &&
			(node as any).variadic_param_index === undefined &&
			overflow_count === 0
		) {
			const inlined = build_inline_function(inline_candidate as FunctionNode, status);
			if (inlined) return;
		}

		status.code += `bl ${func_name}\n`;

		// A float-returning callee hands its result back in d0 (the d0
		// return convention). Bit-cast to x0 so every existing consumer
		// (build_float_operand's fallback, declarations, assignments) keeps
		// seeing the raw pattern in x0.
		if (is_float_type(node.type.name)) {
			status.code += `fmov x0, d0\n`;
		}

		// Free the outgoing stack-arg area now that the call has read it.
		// Restoring sp here (before any post-call code that uses sp — e.g.
		// popping the class-constructor pointer below) keeps the rest of the
		// path unchanged.
		if (outgoing_size > 0) {
			status.code += `add sp, sp, #${outgoing_size}\n`;
		}

		// A non-inlined call may (transitively, via a `ref`/`var`/`mov` receiver
		// or argument) reallocate any Buffer reachable from its parameters,
		// including a cached field buffer such as `obj.field`. The emitter can't
		// see through the callee, so conservatively drop every field-buffer
		// cache entry here (local-variable entries, which have no ".", are left
		// alone — they are only reassigned by the explicit paths above). This
		// keeps field-aware Buffer.data hoisting sound without sacrificing the
		// local-buffer wins (nsieve, lru, …).
		if (status.buffer_data_cache) {
			for (const k of Array.from(status.buffer_data_cache.keys())) {
				if (k.includes(".")) status.buffer_data_cache.delete(k);
			}
		}

		// A `ref` class arg may have been reassigned by the callee, which wrote
		// the new pointer into the caller's slot. The caller's anchor slot (used
		// for cleanup at scope exit) still holds the old pointer — sync it to the
		// slot's current value so the new instance is freed once and the old one
		// (already freed by the callee) is not double-freed. If the callee did
		// not reassign, the slot is unchanged and this is a no-op. Preserve x0
		// across the sync — it holds the call's return value.
		if (ref_class_sync_names.some((n) => find_anchor_slot(status, n) !== undefined)) {
			status.code += `str x0, [sp, #-16]!\n`;
			for (const sync_name of ref_class_sync_names) {
				const anchor = find_anchor_slot(status, sync_name);
				if (anchor !== undefined) {
					emit_var_load(status, "x0", sync_name, 8);
					status.code += `str x0, [x29, #${anchor}]\n`;
				}
			}
			status.code += `ldr x0, [sp], #16\n`;
		}

		// A forwarded `ref` class PARAM may have been reassigned by the callee,
		// which wrote the new instance into the caller's slot. The param's
		// callee-saved register still holds the pre-call instance (possibly
		// already freed by the callee) — reload it from the slot so subsequent
		// field access / method calls target the live instance. x9 is
		// caller-saved scratch (free right after the call); x0 (return value) is
		// preserved across the reload.
		if (ref_class_param_reload.length > 0) {
			status.code += `str x0, [sp, #-16]!\n`;
			for (const reload_name of ref_class_param_reload) {
				const slot = status.ref_class_slots?.get(reload_name);
				const reg = status.function_param_regs?.get(reload_name);
				if (slot !== undefined && reg) {
					status.code += `ldr x9, [x29, #${slot}]\n`;
					status.code += `ldr ${reg}, [x9]\n`;
				}
			}
			status.code += `ldr x0, [sp], #16\n`;
		}

		if (!is_struct && node.type?.name && !status.call_x8_preset) {
			const return_struct = status.structs.find(
				(s) => s.name === node.type!.name && !s.is_simple_type && !s.is_class,
			);
			if (return_struct) {
				const temp_name = `_call_ret_${temp_counter - 1}`;
				const offset = status.stack_offsets!.get(temp_name)!;
				status.code += `add x0, x29, #${offset}\n`;
			}
		}
	}

	build_swap_params(node, status);

	// For struct constructors with a temp, load temp address into x0
	if (is_struct && !status.struct_return_buffer) {
		if (is_struct.is_class) {
			status.code += `ldr x0, [sp], #16\n`;
		} else {
			const temp_addr = `_temp_${temp_counter - 1}`;
			const offset = status.stack_offsets!.get(temp_addr)!;
			status.code += `add x0, x29, #${offset}\n`;
			// `T(...) + [ ... ]` in an expression position (e.g. a call arg or
			// return value) lands in the temp above; apply the named-field
			// overrides to that same temp, then restore x0 (building the
			// override values may have clobbered it).
			if (node.field_overrides?.length) {
				emit_field_overrides(temp_addr, node, build_node, status);
				status.code += `add x0, x29, #${offset}\n`;
			}
		}
	}

	if (node.name.startsWith("_string_interpolate_")) {
		status.interpolate_string_counts.add(node.params.length - 1);
		status.last_result_is_heap = true;
	}

	if (status.heap_returning_functions?.has(node.name)) {
		status.last_result_is_heap = true;
	}

	// A `mov out string` call transfers ownership by signature (the checker
	// stamps owned_return) — the caller owns and must free the result, even
	// when the callee isn't in heap_returning_functions.
	if (
		(node as unknown as { owned_return?: boolean }).owned_return &&
		node.type?.name === "string" &&
		!node.type.is_view
	) {
		status.last_result_is_heap = true;
	}

	if (node.mov_param_indices?.length) {
		for (const idx of node.mov_param_indices) {
			const param = node.params[idx];
			if (param?.node_type === "value") {
				// A `string` mov arg keeps caller ownership (owning
				// Buffer<string> strdup's); skip mark_moved so scope-exit
				// cleanup frees it. Resolve the type from the declaration — a
				// bare variable reference's ValueNode.type is unset after mono —
				// searching every scope frame (the variable may live in an
				// outer scope when the call sits inside an if/loop branch).
				const vname = (param as { value?: string }).value;
				const decl = all_scope_frames(status)
					.flat()
					.find((d) => d.name === vname);
				const tname = decl?.type?.name ?? (param as { type?: { name?: string } }).type?.name;
				if (tname === "string") continue;
			}
			if (param) {
				mark_moved_if_struct(param, status);
			}
		}
	}
}
