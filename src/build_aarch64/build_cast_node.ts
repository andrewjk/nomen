import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { is_float_type } from "../built_in_types.ts";
import { CASE_CAST_PANIC_MESSAGE } from "../check/utils/case_enum.ts";
import CastNode from "../nodes/CastNode.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_enum_payload_strdups_at } from "./utils/auto_destroy.ts";
import { emit_asm, ensure_newline } from "./utils/code_buffer.ts";
import { allocate_stack_space, emit_var_address } from "./utils/stack_var.ts";
import { emit_struct_copy, get_enum_size, get_struct_size } from "./utils/struct_layout.ts";

let cast_temp_counter = 0;

export function reset_cast_temp_counter() {
	cast_temp_counter = 0;
}

/**
 * The checked case cast's variant-mismatch panic — the build_panic_node
 * shape (write syscall + exit syscall, a status.strings label) with a
 * per-site label so two casts in one function don't collide.
 */
function emit_case_cast_panic(status: BuildStatus) {
	const msg = CASE_CAST_PANIC_MESSAGE + "\\n";
	const label = `_str_ecast_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
	status.strings!.set(label, `"${msg}"`);
	const len = msg.length - 1;
	emit_asm(status, `mov x0, #2\n`);
	emit_asm(status, `adr x1, ${label}\n`);
	emit_asm(status, `mov x2, #${len}\n`);
	emit_asm(status, `mov x16, #4\n`);
	emit_asm(status, `svc #0x80\n`);
	emit_asm(status, `mov x0, #1\n`);
	emit_asm(status, `mov x16, #1\n`);
	emit_asm(status, `svc #0x80\n`);
}

export default function build_cast_node(node: CastNode, status: BuildStatus) {
	if (node.operator_func) {
		build_struct_cast(node, status);
		return;
	}

	build_node(node.value, status);
	ensure_newline(status);

	const from_type = type_from_value_node(node.value);
	const from = from_type.name;
	const to = node.target_type.name;

	// BASE↔CASE enum cast (PERF_PLAN item 13(3), the checked case cast) —
	// stamped by check_cast_node. Result convention: ADDRESS in x0 (the
	// struct-rvalue convention) — the result lives in a fresh frame scratch
	// the surrounding declaration/assignment copies from. COPY semantics:
	// the source keeps ownership (no mark_moved); payload deep-copies run
	// in place in the scratch — the same tag-guarded walk the mv load_T
	// uses (emit_enum_payload_strdups_at). `base_to_case` compares the
	// value's tag against the case's ORIGINAL declaration index first and
	// panics on variant mismatch (the build_panic_node shape: write + exit
	// syscalls, a per-site string label).
	if (node.enum_case_conversion) {
		const direction = node.enum_case_conversion.direction;
		const mono_name = direction === "base_to_case" ? to : from;
		const mono = status.enums.find((e) => e.name === mono_name && e.is_case_mono);
		const parent = mono?.parent_enum;
		const parent_enum = parent ? status.enums.find((e) => e.name === parent) : undefined;
		if (mono && parent_enum) {
			if (!mono.has_associated_data) {
				// Zero-payload cases are 8-byte tag words on both sides of the
				// pair: narrowing checks the word against the base case's tag,
				// widening is the same bits — keep x0.
				if (direction === "base_to_case") {
					const tag = mono.cases[0]?.tag_index ?? 0;
					const skip = `.Lecast_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
					emit_asm(status, `cmp x0, #${tag}\n`);
					emit_asm(status, `b.eq ${skip}\n`);
					emit_case_cast_panic(status);
					emit_asm(status, `${skip}:\n`);
				}
				return;
			}
			// The value builds to its own blob's ADDRESS in x0 (the
			// struct-rvalue convention — a local, a call result, or a
			// construction temp all agree).
			const case_size = get_enum_size(mono.name, status);
			const layout_name = direction === "base_to_case" ? mono.name : parent!;
			const dst_size = direction === "base_to_case" ? case_size : get_enum_size(parent!, status);
			const offset = allocate_stack_space(status, dst_size);
			if (direction === "base_to_case") {
				// Narrowing: the runtime tag check FIRST — the ORIGINAL
				// declaration index (a mono's tag value is the base's).
				const tag = mono.cases[0]?.tag_index ?? 0;
				const skip = `.Lecast_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
				emit_asm(status, `ldr x9, [x0]\n`);
				emit_asm(status, `mov x10, #${tag}\n`);
				emit_asm(status, `cmp x9, x10\n`);
				emit_asm(status, `b.eq ${skip}\n`);
				emit_case_cast_panic(status);
				emit_asm(status, `${skip}:\n`);
				// Copy the case-size prefix (the mono's whole layout) into the
				// scratch, then deep-copy the payloads in place: the result is
				// an independent value, the source keeps ownership.
				emit_struct_copy("x0", "x29", offset, case_size, status);
				emit_enum_payload_strdups_at(status, layout_name, "x29", offset);
			} else {
				// Widening: zero the parent-size scratch first (only the
				// case-size prefix gets copied — the tail must be deterministic,
				// the C lowering memsets too), then copy + deep-copy in place.
				// The source address parks across the memset call.
				emit_asm(status, `str x0, [sp, #-16]!\n`);
				emit_asm(status, `add x0, x29, #${offset}\n`);
				emit_asm(status, `mov x1, #0\n`);
				emit_asm(status, `mov x2, #${dst_size}\n`);
				emit_asm(status, `bl _memset\n`);
				emit_asm(status, `ldr x0, [sp], #16\n`);
				emit_struct_copy("x0", "x29", offset, case_size, status);
				emit_enum_payload_strdups_at(status, layout_name, "x29", offset);
			}
			emit_asm(status, `add x0, x29, #${offset}\n`);
			return;
		}
	}

	// `unsafe` pointer casts are bit-no-ops on a register machine: a pointer
	// is already a 64-bit word in x0. A fat string value loads as the
	// (ptr, len) pair and `as ptr char` simply keeps the ptr half.
	if (node.target_type.is_pointer || from_type?.is_pointer) {
		return;
	}

	const fs = aarch64_size(from);
	const ts = aarch64_size(to);

	const is_from_float = is_float_type(from);
	const is_to_float = is_float_type(to);

	if (is_from_float && !is_to_float) {
		// The operand rides x0 as BITS (the float value convention — unary
		// minus and int→float materialize the same way). Convert the BITS,
		// not the raw d0: any call between the value's production and this
		// cast leaves d0 holding something else (a stored float's `as int`
		// printed 0 for 100.0).
		emit_asm(status, `fmov d0, x0\n`);
		emit_asm(status, `fcvtzs x0, d0\n`);
		emit_asm(status, `fmov d0, x0\n`);
		return;
	}

	if (!is_from_float && is_to_float) {
		emit_asm(status, `fmov d0, x0\n`);
		emit_asm(status, `scvtf d0, d0\n`);
		emit_asm(status, `fmov x0, d0\n`);
		return;
	}

	if (from === to || (fs === ts && !is_from_float)) {
		return;
	}

	if (ts > fs) {
		if (from === "bool" || from === "int8" || from === "uint8" || from === "char") {
			if (from === "int8") {
				emit_asm(status, `sxtb x0, x0\n`);
			} else {
				// bool, uint8, char: zero-extend (char is an unsigned code point).
				emit_asm(status, `and x0, x0, #0xFF\n`);
			}
		} else if (from === "int16") {
			emit_asm(status, `sxth x0, x0\n`);
		} else if (from === "uint16") {
			emit_asm(status, `and x0, x0, #0xFFFF\n`);
		} else if (from === "int32" || from === "int") {
			emit_asm(status, `sxtw x0, x0\n`);
		} else if (from === "uint32" || from === "uint") {
			emit_asm(status, `and x0, x0, #0xFFFFFFFF\n`);
		}
	} else if (ts < fs) {
		if (to === "bool" || to === "int8" || to === "uint8" || to === "char") {
			emit_asm(status, `and x0, x0, #0xFF\n`);
		} else if (to === "int16" || to === "uint16") {
			emit_asm(status, `and x0, x0, #0xFFFF\n`);
		} else if (to === "int32" || to === "uint32") {
			emit_asm(status, `and x0, x0, #0xFFFFFFFF\n`);
		}
	}
}

function build_struct_cast(node: CastNode, status: BuildStatus) {
	const target_struct = status.structs.find(
		(s) => s.name === node.target_type.name && !s.is_simple_type,
	);

	let temp_label = "";
	if (target_struct) {
		const struct_size = get_struct_size(node.target_type.name, status);
		const offset = allocate_stack_space(status, struct_size);
		temp_label = `_cast_temp_${cast_temp_counter++}`;
		status.stack_offsets!.set(temp_label, offset);
		emit_asm(status, `add x8, x29, #${offset}\n`);
	}

	if (node.value.node_type === "value") {
		const name = (node.value as any).value;
		const paramReg = status.function_param_regs?.get(name);
		if (paramReg) {
			if (paramReg !== "x0") {
				emit_asm(status, `mov x0, ${paramReg}\n`);
			}
		} else {
			emit_var_address(status, "x0", name);
		}
	} else {
		build_node(node.value, status);
		ensure_newline(status);
	}

	emit_asm(status, `bl ${node.operator_func!.struct_name}_as\n`);

	if (target_struct && temp_label) {
		const offset = status.stack_offsets!.get(temp_label)!;
		emit_asm(status, `add x0, x29, #${offset}\n`);
	}
}
