import type BuildStatus from "../build_c/BuildStatus.ts";
import { enum_with_data_side, static_enum_case } from "../build_c/utils/enum_eq.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import string_literal_length from "../build_common/string_literal_length.ts";
import { is_int_literal, parse_int_literal_bigint, to_decimal_string } from "../int_literal.ts";
import AccessNode from "../nodes/AccessNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import EnumNode from "../nodes/EnumNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { emit_address_of } from "./build_access_node.ts";
import { get_source_address } from "./build_assignment_node.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_free } from "./utils/audit.ts";
import { has_flag_name, is_nullable_struct_type } from "./utils/nullable_struct.ts";
import { allocate_stack_space, emit_var_address, emit_var_load } from "./utils/stack_var.ts";
import { emit_pair_load_x29, emit_pair_store_x29 } from "./utils/string_pair.ts";
import { get_field_has_offset, get_struct_size } from "./utils/struct_layout.ts";
import { emit_view_string_arg, is_view_value } from "./utils/view_value.ts";

let string_counter = 0;
let coalesce_counter = 0;
let view_cmp_counter = 0;
let sc_counter = 0;

export function reset_string_counter() {
	string_counter = 0;
	coalesce_counter = 0;
	view_cmp_counter = 0;
	sc_counter = 0;
}

function is_comparison(op: string): boolean {
	return [">", "<", "==", "!=", ">=", "<="].includes(op);
}

/**
 * Load an enum-with-data operand's case tag (the case's ordinal index) into
 * `target_reg`. A static case reference emits its index immediately; a
 * runtime enum value is built — a variable or struct-field access yields the
 * tag word directly, while constructor forms and calls leave the ADDRESS of
 * a tag+payload temp in x0 (the same convention declarations rely on), whose
 * first word is the tag.
 */
function build_enum_tag_operand(
	operand: BaseNode,
	enum_node: EnumNode,
	target_reg: string,
	status: BuildStatus,
) {
	const case_name = static_enum_case(operand, enum_node, status);
	if (case_name) {
		const idx = enum_node.cases.findIndex((c) => c.name === case_name);
		status.code += `mov ${target_reg}, #${idx}\n`;
		return;
	}
	let node = operand;
	while (node.node_type === "grouped") {
		node = (node as unknown as { value: BaseNode }).value;
	}
	// An enum-with-data VARIABLE reference yields the ADDRESS of its
	// tag+payload blob (build_value_node) — same as constructor forms — so
	// the tag is loaded through it. Params in registers hold the blob address
	// too (by-address convention).
	const var_name = node.node_type === "value" ? (node as ValueNode).value : undefined;
	const is_enum_var =
		var_name !== undefined &&
		((node as ValueNode).type?.name === enum_node.name ||
			status.scoped_declarations?.some(
				(d) => d.name === var_name && d.type.name === enum_node.name,
			));
	const yields_address =
		node.node_type === "func_call" ||
		(node.node_type === "value" && (node as ValueNode).is_enum_shorthand) ||
		is_enum_var ||
		(node.node_type === "access" &&
			(node as unknown as { access: { node_type: string } }).access.node_type === "access_func");
	build_operand(node, "x0", status);
	if (!status.code.endsWith("\n")) status.code += "\n";
	if (yields_address) {
		status.code += `ldr ${target_reg}, [x0]\n`;
	} else if (target_reg !== "x0") {
		status.code += `mov ${target_reg}, x0\n`;
	}
}

function map_cmp(op: string, unsigned: boolean = false): string {
	if (unsigned) {
		switch (op) {
			case ">":
				return "hi";
			case "<":
				return "lo";
			case "==":
				return "eq";
			case "!=":
				return "ne";
			case ">=":
				return "hs";
			case "<=":
				return "ls";
			default:
				return "eq";
		}
	}
	switch (op) {
		case ">":
			return "gt";
		case "<":
			return "lt";
		case "==":
			return "eq";
		case "!=":
			return "ne";
		case ">=":
			return "ge";
		case "<=":
			return "le";
		default:
			return "eq";
	}
}

function map_op(op: string, unsigned: boolean = false): string {
	switch (op) {
		case "+":
			return "add";
		case "-":
			return "sub";
		case "*":
			return "mul";
		case "/":
			return unsigned ? "udiv" : "sdiv";
		case "%":
			return "mod";
		case "<<":
			return "lsl";
		case ">>":
			return unsigned ? "lsr" : "asr";
		case "&":
			return "and";
		case "|":
			return "orr";
		case "^":
			return "eor";
		default:
			return "add";
	}
}

function emit_immediate(target_reg: string, value: string, status: BuildStatus) {
	// Normalise any integer literal (hex/oct/bin/decimal, optional sign) to a
	// decimal string — the aarch64 assembler only accepts decimal immediates
	// (or a quoted `=N` literal-pool load), not `#0x..`/`#0o..`/`#0b..`. Use
	// BigInt for the magnitude check so large 64-bit constants aren't rounded
	// by JS's double (and so `parseInt(.., 10)` doesn't mis-parse hex as 0).
	const dec = to_decimal_string(value);
	const n = parse_int_literal_bigint(value);
	if (n !== null && n >= 0n && n <= 65535n) {
		status.code += `mov ${target_reg}, #${dec}`;
	} else {
		status.code += `ldr ${target_reg}, =${dec}`;
	}
}

function build_operand(node: BaseNode, target_reg: string, status: BuildStatus) {
	if (node.node_type === "value") {
		const value = (node as ValueNode).value.replace("self", "_self");
		if (value === "true" || value === "false") {
			emit_immediate(target_reg, value === "true" ? "1" : "0", status);
			return;
		}
		if (is_int_literal(value)) {
			emit_immediate(target_reg, value, status);
			return;
		}
		const paramReg = status.function_param_regs?.get(value);
		if (paramReg) {
			if (status.function_param_vars?.has(value) || status.function_ref_params?.has(value)) {
				const param_type_name = (node as ValueNode).type?.name;
				const is_class =
					param_type_name && status.structs.find((s) => s.name === param_type_name && s.is_class);
				if (is_class) {
					if (paramReg !== target_reg) {
						status.code += `mov ${target_reg}, ${paramReg}`;
					}
				} else {
					status.code += `ldr ${target_reg}, [${paramReg}]`;
				}
			} else if (paramReg !== target_reg) {
				status.code += `mov ${target_reg}, ${paramReg}`;
			}
			return;
		}
		if (value.startsWith("'") && value.endsWith("'") && value.length === 3) {
			const char_code = value.charCodeAt(1);
			if (char_code <= 65535) {
				status.code += `mov ${target_reg}, #${char_code}`;
			} else {
				status.code += `ldr ${target_reg}, =${char_code}`;
			}
			return;
		}
		if (value.startsWith('"')) {
			const label = `_str_op_${string_counter++}`;
			status.strings!.set(label, value);
			// Fat-string literal: emit the (ptr, len) pair.
			status.code += `adr ${target_reg}, ${label}\n`;
			const n = parseInt(target_reg.substring(1), 10);
			status.code += `mov x${n + 1}, #${string_literal_length(value)}\n`;
			return;
		}
	}
	build_node(node, status);
	if (target_reg !== "x0") {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `mov ${target_reg}, x0\n`;
	}
}

function is_simple(node: BaseNode): boolean {
	return node.node_type === "value";
}

function is_float_type(node: BaseNode): boolean {
	const type = type_from_value_node(node);
	const name = type?.name || "";
	return name === "float" || name === "float32" || name === "float64" || name === "ufloat";
}

function is_unsigned_type(node: BaseNode): boolean {
	const type = type_from_value_node(node);
	const name = type?.name || "";
	return name === "uint64" || name === "uint32" || name === "uint8";
}

function build_float_operand(node: BaseNode, target_reg: string, status: BuildStatus) {
	if (node.node_type === "value") {
		const value = (node as ValueNode).value.replace("self", "_self");
		if (/^(\+|-)*\d+.\d+$/.test(value)) {
			const label = `_float_op_${string_counter++}`;
			const data = `${label}: .double ${value}\n.p2align 2\n`;
			if (status.function_return_label) {
				if (!status.function_data) status.function_data = "";
				status.function_data += data;
			} else {
				status.code += data;
			}
			status.code += `adr x3, ${label}\n`;
			status.code += `ldr ${target_reg}, [x3]\n`;
			return;
		}
		if (/^(\+|-)*\d+$/.test(value)) {
			status.code += `ldr x3, =${to_decimal_string(value)}\n`;
			status.code += `scvtf ${target_reg}, x3\n`;
			return;
		}
		const alloc_reg_op = status.register_allocations?.get(value);
		if (alloc_reg_op) {
			status.code += `fmov ${target_reg}, ${alloc_reg_op}\n`;
			return;
		}
		const offset = status.stack_offsets?.get(value);
		if (offset !== undefined) {
			status.code += `ldr ${target_reg}, [x29, #${offset}]\n`;
			return;
		}
	}
	const child_is_float = is_float_type(node);
	if (child_is_float) {
		status.float_result_in_d0 = true;
	}
	build_node(node, status);
	if (!status.code.endsWith("\n")) status.code += "\n";
	if (child_is_float && !status.float_result_in_d0) {
		if (target_reg !== "d0") {
			status.code += `fmov ${target_reg}, d0\n`;
		}
	} else {
		status.float_result_in_d0 = false;
		status.code += `fmov ${target_reg}, x0\n`;
	}
}

function map_float_op(op: string): string {
	switch (op) {
		case "+":
			return "fadd";
		case "-":
			return "fsub";
		case "*":
			return "fmul";
		case "/":
			return "fdiv";
		default:
			return "fmul";
	}
}

function is_struct_type(node: BaseNode, status: BuildStatus): boolean {
	const type = type_from_value_node(node as ValueNode);
	return !!status.structs.find((s) => s.name === type.name && !s.is_simple_type);
}

function build_operator_operand(node: BaseNode, target_reg: string, status: BuildStatus) {
	if (node.node_type === "value" && is_struct_type(node, status)) {
		const name = (node as ValueNode).value;
		emit_var_address(status, target_reg, name);
		return;
	}
	// A struct/class field access operand (e.g. `self.funds`) must be passed by
	// address — build_operand would load its first word as a value.
	if (node.node_type === "access" && is_struct_type(node, status)) {
		emit_address_of(node, status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		if (target_reg !== "x0") {
			status.code += `mov ${target_reg}, x0\n`;
		}
		return;
	}
	build_operand(node, target_reg, status);
}

export default function build_operation_node(node: OperationNode, status: BuildStatus) {
	// Resolve a deferred == / != operator (set during generic-body checking
	// when the operands were unresolved type params) against the now-concrete
	// operand type. If the struct defines `eq`/`ne`, dispatch to it; otherwise
	// clear the marker so the builtin comparison path handles it.
	if (node.operator_func?.deferred) {
		// After monomorphization, at least one operand has a concrete
		// substituted type (ValueNodes are substituted; access-func results
		// like `load_T()` may keep the generic "T"). Try both sides.
		let left_type = type_from_value_node(node.left_value);
		let struct = status.structs.find((s) => s.name === left_type.name);
		if (!struct) {
			const right_type = type_from_value_node(node.right_value);
			struct = status.structs.find((s) => s.name === right_type.name);
		}
		const target = node.operator_func.func_name;
		const dual = target === "eq" ? "ne" : "eq";
		let func = struct?.functions.find((f) => f.name === target);
		let invert = false;
		if (!func && struct) {
			func = struct.functions.find((f) => f.name === dual);
			invert = !!func;
		}
		if (func && struct) {
			node.operator_func = {
				struct_name: struct.name,
				func_name: func.name,
				invert,
			};
		} else {
			node.operator_func = undefined;
		}
	}

	if (node.op === "!") {
		build_node(node.right_value, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `cmp x0, #0\n`;
		status.code += `cset x0, eq\n`;
		return;
	}

	// Unary minus: evaluate the operand into x0, then negate it.
	if (node.op === "u-") {
		build_node(node.right_value, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `neg x0, x0\n`;
		return;
	}

	// `??` (null-coalescing) is lazy: the right operand is only evaluated when
	// the left is null. This matters when the fallback allocates (e.g.
	// `x ?? Box(99)`) — eagerly evaluating it would leak the unused instance.
	if (node.op === "??") {
		// Nullable struct `??` checks the `_has` flag instead of the value.
		// The left operand's ADDRESS (the struct value start) must survive
		// across the flag load and be the result when non-null. Build it
		// first, spill to a stack slot, then load the flag and branch.
		if (is_nullable_struct_type(type_from_value_node(node.left_value), status)) {
			build_operand(node.left_value, "x0", status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			const spill = allocate_stack_space(status, 8);
			status.code += `str x0, [x29, #${spill}]\n`;
			load_nullable_has(node.left_value, "x0", status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			const have_label = `.Lcoalesce_have_${coalesce_counter++}`;
			const done_label = `.Lcoalesce_done_${coalesce_counter++}`;
			status.code += `cmp x0, #0\n`;
			status.code += `b.ne ${have_label}\n`;
			build_operand(node.right_value, "x0", status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `b ${done_label}\n`;
			status.code += `${have_label}:\n`;
			status.code += `ldr x0, [x29, #${spill}]\n`;
			status.code += `${done_label}:\n`;
			return;
		}
		build_operand(node.left_value, "x0", status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `cmp x0, #0\n`;
		const label = `.Lcoalesce_have_${coalesce_counter++}`;
		status.code += `b.ne ${label}\n`;
		build_operand(node.right_value, "x0", status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `${label}:\n`;
		return;
	}

	// `x == null` / `x != null` against a nullable struct: compare its
	// companion `_has` flag rather than the struct value.
	if (
		(node.op === "==" || node.op === "!=") &&
		is_null_literal(node.left_value) !== is_null_literal(node.right_value)
	) {
		const nullable_side = is_nullable_struct_type(type_from_value_node(node.left_value), status)
			? node.left_value
			: node.right_value;
		if (is_nullable_struct_type(type_from_value_node(nullable_side), status)) {
			load_nullable_has(nullable_side, "x1", status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			// has==1 means non-null. `== null` → !has (eq 0); `!= null` → has (ne 0).
			status.code += `cmp x1, #0\n`;
			status.code += `cset x0, ${node.op === "==" ? "eq" : "ne"}\n`;
			return;
		}
	}

	// `==`/`!=` on an enum with associated data compares the TAG only. The
	// operands are multi-word values (tag + payload): a variable or field
	// access builds to its tag word, while constructor forms and calls leave
	// the ADDRESS of a tag+payload temp in x0 — the generic path would compare
	// a tag against an address. Mirrors `match`, which discriminates on the tag.
	if (
		(node.op === "==" || node.op === "!=") &&
		enum_with_data_side(node.left_value, node.right_value, status)
	) {
		const enum_node = enum_with_data_side(node.left_value, node.right_value, status)!;
		build_enum_tag_operand(node.right_value, enum_node, "x2", status);
		status.code += `str x2, [sp, #-16]!\n`;
		build_enum_tag_operand(node.left_value, enum_node, "x1", status);
		status.code += `ldr x2, [sp], #16\n`;
		status.code += `cmp x1, x2\n`;
		status.code += `cset x0, ${node.op === "==" ? "eq" : "ne"}\n`;
		return;
	}

	// A string comparison (`a == b`) with a VIEW operand must not dispatch to
	// string_eq/strcmp: a view into the middle of a buffer is not
	// NUL-terminated. Compare as slices: equal lengths, then equal bytes
	// (memcmp). An owned operand is measured with strlen for the comparison.
	if (
		(node.op === "==" || node.op === "!=") &&
		node.operator_func?.struct_name === "string" &&
		(is_view_value(node.left_value, status) || is_view_value(node.right_value, status))
	) {
		const id = view_cmp_counter++;
		const len_ne_label = `.Lview_cmp_len_ne_${id}`;
		const done_label = `.Lview_cmp_done_${id}`;
		// (ptr, len) for the right operand, spilled; then the left.
		emit_view_string_arg(node.right_value, status);
		status.code += `stp x0, x1, [sp, #-16]!\n`;
		emit_view_string_arg(node.left_value, status);
		status.code += `ldr x2, [sp, #8]\n`;
		status.code += `cmp x1, x2\n`;
		status.code += `b.ne ${len_ne_label}\n`;
		status.code += `mov x2, x1\n`; // size
		status.code += `ldr x1, [sp]\n`; // right ptr
		status.code += `bl _memcmp\n`;
		status.code += `cmp x0, #0\n`;
		status.code += `cset x0, ${node.op === "==" ? "eq" : "ne"}\n`;
		status.code += `b ${done_label}\n`;
		status.code += `${len_ne_label}:\n`;
		status.code += `mov x0, #0\n`;
		if (node.op === "!=") {
			status.code += `mov x0, #1\n`;
		}
		status.code += `${done_label}:\n`;
		status.code += `add sp, sp, #16\n`;
		return;
	}

	if (node.operator_func) {
		const left_type = type_from_value_node(node.left_value);
		const is_array_op = node.operator_func.struct_name.startsWith("Array") && left_type.is_array;

		const return_struct = status.structs.find(
			(s) => s.name === node.type?.name && !s.is_simple_type && !s.is_class,
		);
		let return_temp_offset: number | undefined;
		if (return_struct) {
			return_temp_offset = allocate_stack_space(status, get_struct_size(node.type!.name, status));
			status.code += `add x8, x29, #${return_temp_offset}\n`;
		}

		// For array + and *, allocate result with length prefix and call the
		// monomorphized Array function (e.g. Array_int_add)
		if (is_array_op) {
			const elem_size = aarch64_size(left_type.name);
			const result_len = node.type?.length
				? parseInt((node.type.length as any).value || "0", 10)
				: 0;

			// Allocate result buffer with length prefix
			const alloc_start = allocate_stack_space(status, 8 + elem_size * result_len);
			return_temp_offset = alloc_start + 8;
			status.code += `add x8, x29, #${return_temp_offset}\n`;
		}

		// Check if operands are owned heap temps before building them
		const right_is_heap =
			node.type?.name === "string" && is_owned_heap_temp(node.right_value, status);
		const left_is_heap =
			node.type?.name === "string" && is_owned_heap_temp(node.left_value, status);

		if (node.type?.name === "string" || node.operator_func.struct_name === "string") {
			// Fat-string operator call: each operand is a (ptr, len) pair.
			// Evaluate right, spill its pair; evaluate left into (x0, x1);
			// reload right's pair into (x2, x3); call. Owned-temp frees happen
			// after the call (the callee has copied by then), and a string
			// result's pair is spilled across the frees.
			const right_spill_pair = allocate_stack_space(status, 16, 16);
			build_operator_operand(node.right_value, "x0", status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			emit_pair_store_x29(status, right_spill_pair);

			const left_spill_pair = allocate_stack_space(status, 16, 16);
			build_operator_operand(node.left_value, "x0", status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
			emit_pair_store_x29(status, left_spill_pair);
			// Self = left pair in (x0, x1); other = right pair in (x2, x3).
			emit_pair_load_x29(status, left_spill_pair);
			emit_pair_load_x29(status, right_spill_pair, "x2", "x3");

			const op_label =
				node.operator_func.mangled_name ||
				`${node.operator_func.struct_name}_${node.operator_func.func_name}`;
			status.code += `bl ${op_label}\n`;

			const returns_string = node.type?.name === "string";
			let result_pair_spill: number | undefined;
			if (returns_string || left_is_heap || right_is_heap) {
				result_pair_spill = allocate_stack_space(status, 16, 16);
				emit_pair_store_x29(status, result_pair_spill);
			}

			if (left_is_heap) {
				status.code += `ldr x0, [x29, #${left_spill_pair}]\n`;
				emit_free(status);
			}
			if (right_is_heap) {
				status.code += `ldr x0, [x29, #${right_spill_pair}]\n`;
				emit_free(status);
			}
			if (result_pair_spill !== undefined) {
				emit_pair_load_x29(status, result_pair_spill);
			}
			if (node.operator_func.invert) {
				status.code += `cmp x0, #0\n`;
				status.code += `cset x0, eq\n`;
			}
			if (returns_string) {
				status.last_result_is_heap = true;
			}
			return;
		}

		// Evaluate right operand, spill to stack (left evaluation may clobber x1)
		const right_spill = allocate_stack_space(status, 8);
		build_operator_operand(node.right_value, "x0", status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `str x0, [x29, #${right_spill}]\n`;

		// Always spill left operand — nested ops (e.g. s * n) return in x0
		// which we must preserve through the spill/restore sequence.
		const left_spill = allocate_stack_space(status, 8);
		build_operator_operand(node.left_value, "x0", status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `str x0, [x29, #${left_spill}]\n`;

		// Restore right operand into x1
		status.code += `ldr x1, [x29, #${right_spill}]\n`;

		const label =
			node.operator_func.mangled_name ||
			`${node.operator_func.struct_name}_${node.operator_func.func_name}`;
		status.code += `bl ${label}\n`;

		// Save result before freeing heap temps (emit_free clobbers x0).
		const has_heap_temps = left_is_heap || right_is_heap;
		let result_spill: number | undefined;
		if (has_heap_temps) {
			result_spill = allocate_stack_space(status, 8);
			status.code += `str x0, [x29, #${result_spill}]\n`;
		}

		if (return_struct && return_temp_offset !== undefined) {
			status.code += `add x0, x29, #${return_temp_offset}\n`;
		}

		// Free owned heap temp operands AFTER the operator has consumed them.
		if (left_is_heap) {
			status.code += `ldr x0, [x29, #${left_spill}]\n`;
			emit_free(status);
		}
		if (right_is_heap) {
			status.code += `ldr x0, [x29, #${right_spill}]\n`;
			emit_free(status);
		}

		// Restore result if it was spilled.
		if (result_spill !== undefined) {
			status.code += `ldr x0, [x29, #${result_spill}]\n`;
		}

		// `!=` dispatched to a struct's `eq` (or `==` to `ne`): invert the
		// boolean call result in x0.
		if (node.operator_func.invert) {
			status.code += `cmp x0, #0\n`;
			status.code += `cset x0, eq\n`;
		}

		// Operator functions that return strings produce heap-allocated results.
		if (node.type?.name === "string") {
			status.last_result_is_heap = true;
		}
		return;
	}

	const is_float =
		is_float_type(node) || is_float_type(node.left_value) || is_float_type(node.right_value);

	// Constant folding: if both operands are literals, compute at compile time.
	if (
		!is_float &&
		node.left_value.node_type === "value" &&
		node.right_value.node_type === "value"
	) {
		const lv_raw = (node.left_value as ValueNode).value;
		const rv_raw = (node.right_value as ValueNode).value;
		if (/^(\+|-)*\d+$/.test(lv_raw) && /^(\+|-)*\d+$/.test(rv_raw)) {
			const left = parseInt(lv_raw, 10);
			const right = parseInt(rv_raw, 10);
			let result: number | undefined;
			switch (node.op) {
				case "+":
					result = left + right;
					break;
				case "-":
					result = left - right;
					break;
				case "*":
					result = left * right;
					break;
				case "/":
					if (right !== 0) result = Math.trunc(left / right);
					break;
				case "%":
					if (right !== 0) result = left - Math.trunc(left / right) * right;
					break;
				case "<<":
					result = left << right;
					break;
				case ">>":
					result = left >> right;
					break;
				case "&":
					result = left & right;
					break;
				case "|":
					result = left | right;
					break;
				case "^":
					result = left ^ right;
					break;
				case "&&":
					result = left !== 0 && right !== 0 ? 1 : 0;
					break;
				case "||":
					result = left !== 0 || right !== 0 ? 1 : 0;
					break;
				case "==":
					result = left === right ? 1 : 0;
					break;
				case "!=":
					result = left !== right ? 1 : 0;
					break;
				case "<":
					result = left < right ? 1 : 0;
					break;
				case ">":
					result = left > right ? 1 : 0;
					break;
				case "<=":
					result = left <= right ? 1 : 0;
					break;
				case ">=":
					result = left >= right ? 1 : 0;
					break;
			}
			if (result !== undefined) {
				emit_immediate("x0", String(result), status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				return;
			}
		}
	}

	if (is_float && !is_comparison(node.op)) {
		const caller_wants_d0 = status.float_result_in_d0 ?? false;
		status.float_result_in_d0 = false;
		const need_float_spill = !is_simple(node.left_value);
		build_float_operand(node.right_value, "d1", status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		if (need_float_spill) {
			status.code += `str d1, [sp, #-16]!\n`;
		}
		build_float_operand(node.left_value, "d0", status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		if (need_float_spill) {
			status.code += `ldr d1, [sp], #16\n`;
		}
		status.code += `${map_float_op(node.op)} d0, d0, d1\n`;
		if (caller_wants_d0) {
			status.float_result_in_d0 = false;
		} else {
			status.code += `fmov x0, d0\n`;
		}
		return;
	}

	// `&&` / `||` SHORT-CIRCUIT: the right operand must not be evaluated when
	// the left decides the result (`i < n && items.at(i)...` — evaluating the
	// right unconditionally reads past the end on the loop-exit iteration).
	// Mirrors C's && / || semantics, which the C backend inherits for free.
	if (node.op === "&&" || node.op === "||") {
		const id = sc_counter++;
		const skip_right = `.Lsc_skip_${id}`;
		const done = `.Lsc_done_${id}`;
		build_operand(node.left_value, "x0", status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		status.code += `cmp x0, #0\n`;
		status.code += node.op === "&&" ? `b.eq ${skip_right}\n` : `b.ne ${skip_right}\n`;
		build_operand(node.right_value, "x0", status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		status.code += `cmp x0, #0\n`;
		status.code += `cset x0, ne\n`;
		status.code += `b ${done}\n`;
		status.code += `${skip_right}:\n`;
		if (node.op === "&&") {
			status.code += `mov x0, #0\n`;
		} else {
			status.code += `mov x0, #1\n`;
		}
		status.code += `${done}:\n`;
		return;
	}

	const need_spill = !is_simple(node.left_value);

	build_operand(node.right_value, "x2", status);
	if (need_spill) {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		status.code += `str x2, [sp, #-16]!\n`;
	} else {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	build_operand(node.left_value, "x1", status);
	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}
	if (need_spill) {
		status.code += `ldr x2, [sp], #16\n`;
	}

	const unsigned = is_unsigned_type(node.left_value) || is_unsigned_type(node.right_value);

	if (is_comparison(node.op)) {
		status.code += `cmp x1, x2\n`;
		status.code += `cset x0, ${map_cmp(node.op, unsigned)}\n`;
	} else {
		const op = map_op(node.op, unsigned);
		if (op === "mod") {
			const div_op = unsigned ? "udiv" : "sdiv";
			status.code += `${div_op} x3, x1, x2\n`;
			status.code += `msub x0, x3, x2, x1\n`;
		} else {
			status.code += `${op} x0, x1, x2\n`;
		}
	}
}

// Whether an operand node produces a fresh heap string that is safe to free
// once consumed (nested concat/repeat, interpolation, or a *_to_string call).
// Variables, literals, and arbitrary function calls are NOT freed here because
// they may be static or owned elsewhere.
function is_owned_heap_temp(node: BaseNode, status?: BuildStatus): boolean {
	// Method calls land in an `access` node wrapping an `access_func` (e.g.
	// `Ansi.green(...)`). Unwrap and check the mangled `StructName_func` label,
	// and pull the result type off the access_func since the wrapping access
	// node doesn't always carry it.
	let target_value: string | undefined;
	let target_type_name: string | undefined;
	let check_node = node;
	let check_type_name = (node as { type?: { name?: string } }).type?.name;
	if (node.node_type === "access") {
		const access_node = node as unknown as {
			access?: { node_type?: string; type?: { name?: string } };
			target?: { value?: string; type?: { name?: string } };
		};
		if (access_node.access?.node_type !== "access_func") return false;
		target_value = access_node.target?.value;
		target_type_name = access_node.target?.type?.name;
		if (!target_type_name && (node as any).target) {
			try {
				target_type_name = type_from_value_node((node as any).target)?.name;
			} catch {
				target_type_name = undefined;
			}
		}
		check_node = access_node.access as unknown as BaseNode;
		check_type_name = access_node.access?.type?.name;
	}
	if (check_type_name !== "string") return false;
	if (check_node.node_type === "op") return true;
	if (check_node.node_type === "func_call" || check_node.node_type === "access_func") {
		const raw_name = (check_node as unknown as { name: string }).name;
		const mangled = (check_node as unknown as { mangled_name?: string }).mangled_name || raw_name;
		if (mangled.startsWith("_string_interpolate_")) return true;
		if (mangled.endsWith("_to_string") && mangled !== "string_to_string") return true;
		// A bare `.to_string()` on a non-string target (e.g. `n.to_string()`,
		// emitted as `int_to_string`) returns a fresh owned heap string. The
		// AST method name is just `to_string` with no type prefix, so match it
		// via the target's type rather than the mangled label.
		if (raw_name === "to_string" && target_type_name && target_type_name !== "string") return true;
		// `.to_string()` on a `view string` receiver (named or an inline
		// `.slice(...)` chain) MATERIALIZES a fresh owned heap copy — safe to
		// free once consumed. (`to_string` on an owned string is the
		// `string_to_string` identity, a borrow — excluded by is_view_value.)
		if (
			raw_name === "to_string" &&
			status &&
			node.node_type === "access" &&
			is_view_value((node as AccessNode).target, status)
		) {
			return true;
		}
		const heap_set = status?.heap_returning_functions;
		if (heap_set?.has(mangled)) return true;
		// Non-overloaded struct methods don't carry a precomputed mangled_name on
		// the AST; the build phase emits them as `StructName_func`. Try that.
		if (heap_set && target_value && heap_set.has(`${target_value}_${raw_name}`)) return true;
		return false;
	}
	return false;
}

function is_null_literal(node: BaseNode): boolean {
	return node.node_type === "value" && (node as ValueNode).value === "null";
}

/**
 * Load a nullable-struct lvalue's companion `_has` flag into `target_reg`.
 * Handles:
 *   - a bare LOCAL variable (flag at `has_flag_name(name)` stack offset)
 *   - a bare PARAMETER variable (the param's pointer is in a callee-saved
 *     register; the flag is at `[reg + struct_size]`, immediately after the
 *     inline struct value)
 *   - a field access `obj.field` (flag at the field's has-offset within obj)
 *   - a function call result (the call materialised the result into a temp
 *     with both the struct value and the flag; load the flag from
 *     `[temp + struct_size]`)
 */
function load_nullable_has(node: BaseNode, target_reg: string, status: BuildStatus) {
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		// A nullable struct PARAMETER: the param's pointer lives in a
		// callee-saved register (callee_map / function_param_regs). The flag
		// lives at `[ptr + struct_size]` in the caller's combined storage.
		const param_reg = status.function_param_regs?.get(name);
		if (param_reg) {
			const t = (node as ValueNode).type;
			if (t?.name) {
				const struct_size = get_struct_size(t.name, status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				if (target_reg !== param_reg) {
					status.code += `mov ${target_reg}, ${param_reg}\n`;
				}
				status.code += `ldr ${target_reg}, [${target_reg}, #${struct_size}]\n`;
				return;
			}
		}
		emit_var_load(status, target_reg, has_flag_name(name), 8);
		return;
	}
	if (node.node_type === "access" && (node as any).access.node_type === "access_field") {
		const access = node as any;
		const target_type = type_from_value_node(access.target);
		const field_name = access.access.name;
		if (target_type?.name) {
			const has_off = get_field_has_offset(target_type.name, field_name, status);
			// Resolve the target object's base address into x0 (NOT its value —
			// ref params must not be dereferenced here), then load the flag word.
			get_source_address(access.target, status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			if (target_reg !== "x0") {
				status.code += `mov ${target_reg}, x0\n`;
			}
			if (has_off === 0) {
				status.code += `ldr ${target_reg}, [${target_reg}]\n`;
			} else {
				status.code += `ldr ${target_reg}, [${target_reg}, #${has_off}]\n`;
			}
			return;
		}
	}
	// Function call result: the call was materialised into a temp with the
	// flag at `[temp + struct_size]`. Resolve the temp's address and load.
	if (node.node_type === "func_call") {
		const t = (node as any).type;
		if (t?.name) {
			const struct_size = get_struct_size(t.name, status);
			// Build the call expression: it leaves x0 = address of the temp
			// (struct value start). Load the flag from there.
			build_operand(node, target_reg, status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `ldr ${target_reg}, [${target_reg}, #${struct_size}]\n`;
			return;
		}
	}
	// Fallback: build the value (shouldn't happen for valid nullable lvalues).
	build_operand(node, target_reg, status);
}
