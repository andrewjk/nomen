import type BuildStatus from "../build_c/BuildStatus.ts";
import flatten_null_chain from "../build_common/null_chain.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type NullAccessNode from "../nodes/NullAccessNode.ts";
import { build_operand, emit_null_hop_tests } from "./build_operation_node.ts";
import { emit_typed_store } from "./build_struct_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_strdup } from "./utils/audit.ts";
import { emit_asm, ensure_newline } from "./utils/code_buffer.ts";
import { allocate_stack_space, emit_var_store } from "./utils/stack_var.ts";
import { emit_struct_copy, get_struct_size } from "./utils/struct_layout.ts";

let chain_label_counter = 0;

/** Where a lowered chain value lands.
 * - `expression`: generic value position — a string yields the (x0, x1) pair,
 *   a scalar/struct the ADDRESS of a temp holding (value @0, flag @+size),
 *   the same shape a nullable call result uses.
 * - `local`: a declaration/assignment destination — the value is written
 *   straight into the named local's slot and its companion `_has` flag.
 * - `sret`: the caller's return buffer — value at +0 (natural width for
 *   scalars, struct-size words for structs), flag at +size. */
export type NullChainDest =
	| { kind: "expression" }
	| { kind: "local"; name: string }
	| { kind: "sret" };

/**
 * Lower a nullable chain as a nullable VALUE (ERRORS_PLAN v2 growth): hop
 * tests branch over the guarded value path or the null carrier, writing the
 * destination exactly once per arm. Strings carry null IN BAND (the fat
 * zero pair); scalars and structs write the companion `_has` flag — the
 * same per-slot representations a nullable call result uses. The string
 * value arm is strdup'd into an owned copy unless it is a producer (a call
 * — its fresh result transfers), mirroring the `??` arm convention.
 */
export function emit_null_chain_value_a64(
	node: NullAccessNode,
	status: BuildStatus,
	dest: NullChainDest,
): void {
	const flat = flatten_null_chain(node, (t, f) => {
		const st = status.structs.findLast((s) => s.name === t && !s.is_generic);
		return st?.fields.find((fld) => fld.name === f)?.type;
	});
	if (!flat) return;
	const t = node.type;
	const is_str = t?.name === "string" && !t.is_view;
	const struct_name = t?.name
		? status.structs.find((st) => st.name === t.name && !st.is_simple_type && !st.is_class)
			? t.name
			: undefined
		: undefined;
	const value_is_producer =
		flat.value.node_type === "func_call" ||
		(flat.value.node_type === "access" &&
			(flat.value as AccessNode).access.node_type === "access_func");
	const done_label = `.Lnull_chain_done_${chain_label_counter++}`;
	const null_label = `.Lnull_chain_null_${chain_label_counter++}`;

	if (is_str && dest.kind === "expression") {
		// In-band null: guarded owned pair or the fat zero pair, yielded in
		// x0/x1 (the same convention every string consumer reads).
		const slot = allocate_stack_space(status, 16);
		emit_null_hop_tests(flat.hops, null_label, status);
		build_operand(flat.value, "x0", status);
		ensure_newline(status);
		if (!value_is_producer) emit_strdup(status);
		ensure_newline(status);
		emit_asm(status, `stp x0, x1, [x29, #${slot}]\n`);
		emit_asm(status, `b ${done_label}\n`);
		emit_asm(status, `${null_label}:\n`);
		emit_asm(status, `stp xzr, xzr, [x29, #${slot}]\n`);
		emit_asm(status, `${done_label}:\n`);
		emit_asm(status, `ldp x0, x1, [x29, #${slot}]\n`);
		// The value arm is owned (strdup'd or a producer's fresh buffer) and
		// the null arm is a free no-op — the consumer may record the binding
		// as heap-owned (check_heap keys on this flag).
		status.last_result_is_heap = true;
		return;
	}

	if (is_str) {
		// String into a slot destination (local or sret): same pair shape,
		// stored straight into the destination.
		emit_null_hop_tests(flat.hops, null_label, status);
		build_operand(flat.value, "x0", status);
		ensure_newline(status);
		if (!value_is_producer) emit_strdup(status);
		ensure_newline(status);
		if (dest.kind === "local") {
			// A string local's slot is the 16-byte fat pair (emit_var_store
			// stores the pair through the string_pair helpers' layout).
			emit_var_store(status, "x0", dest.name, 16);
			ensure_newline(status);
			emit_asm(status, `mov x9, #1\n`);
			emit_var_store(status, "x9", `${dest.name}_has`, 8);
		} else {
			emit_asm(status, `ldr x8, [x29, #${status.return_buffer_stack_offset ?? 0}]\n`);
			emit_asm(status, `stp x0, x1, [x8]\n`);
			emit_asm(status, `mov x9, #1\n`);
			emit_asm(status, `str x9, [x8, #16]\n`);
		}
		emit_asm(status, `b ${done_label}\n`);
		emit_asm(status, `${null_label}:\n`);
		if (dest.kind === "local") {
			emit_asm(status, `mov x9, xzr\n`);
			emit_var_store(status, "x9", `${dest.name}_has`, 8);
		} else {
			emit_asm(status, `ldr x8, [x29, #${status.return_buffer_stack_offset ?? 0}]\n`);
			emit_asm(status, `str xzr, [x8, #16]\n`);
		}
		emit_asm(status, `${done_label}:\n`);
		return;
	}

	const is_scalar = !struct_name;
	const scalar_size = is_scalar ? Math.max(aarch64_size(t?.name ?? "long"), 1) : 0;
	const struct_size = struct_name ? get_struct_size(struct_name, status) : 0;
	const flag_size_off = is_scalar ? 8 : struct_size;

	if (dest.kind === "local") {
		// Write the guarded value straight into the local's slot; the flag
		// word records the arm taken.
		emit_null_hop_tests(flat.hops, null_label, status);
		build_operand(flat.value, "x0", status);
		ensure_newline(status);
		if (is_scalar) {
			emit_var_store(status, "x0", dest.name, scalar_size);
		} else {
			// A struct value path yields its ADDRESS in x0 (a field chain
			// build loads through the hops; a call result arrives as the
			// sret/temp address already).
			const dst_offset = status.stack_offsets?.get(dest.name) ?? 0;
			emit_struct_copy("x0", "x29", dst_offset, struct_size, status);
		}
		emit_asm(status, `mov x9, #1\n`);
		emit_var_store(status, "x9", `${dest.name}_has`, 8);
		emit_asm(status, `b ${done_label}\n`);
		emit_asm(status, `${null_label}:\n`);
		emit_asm(status, `mov x9, xzr\n`);
		emit_var_store(status, "x9", `${dest.name}_has`, 8);
		emit_asm(status, `${done_label}:\n`);
		return;
	}

	if (dest.kind === "sret") {
		// The caller's buffer: value at +0, flag at +size (the layout the
		// nullable-return path writes for every non-null return).
		emit_null_hop_tests(flat.hops, null_label, status);
		build_operand(flat.value, "x0", status);
		ensure_newline(status);
		emit_asm(status, `ldr x8, [x29, #${status.return_buffer_stack_offset ?? 0}]\n`);
		if (is_scalar) {
			emit_typed_store(status, "x0", "x8", 0, scalar_size);
		} else {
			emit_struct_copy("x0", "x8", 0, struct_size, status);
		}
		emit_asm(status, `mov x9, #1\n`);
		emit_asm(status, `str x9, [x8, #${flag_size_off}]\n`);
		emit_asm(status, `b ${done_label}\n`);
		emit_asm(status, `${null_label}:\n`);
		emit_asm(status, `ldr x8, [x29, #${status.return_buffer_stack_offset ?? 0}]\n`);
		emit_asm(status, `str xzr, [x8, #${flag_size_off}]\n`);
		emit_asm(status, `${done_label}:\n`);
		return;
	}

	// Generic expression: a temp whose ADDRESS lands in x0 — value @0, flag
	// @+size — the same shape a nullable call result leaves for its
	// consumers (declaration/assignment sites read [x0] and [x0, #8]).
	const slot = allocate_stack_space(status, is_scalar ? 16 : struct_size + 8, 8);
	emit_null_hop_tests(flat.hops, null_label, status);
	build_operand(flat.value, "x0", status);
	ensure_newline(status);
	if (is_scalar) {
		emit_asm(status, `str x0, [x29, #${slot}]\n`);
	} else {
		emit_struct_copy("x0", "x29", slot, struct_size, status);
	}
	emit_asm(status, `mov x9, #1\n`);
	emit_asm(status, `str x9, [x29, #${slot + flag_size_off}]\n`);
	emit_asm(status, `b ${done_label}\n`);
	emit_asm(status, `${null_label}:\n`);
	emit_asm(status, `str xzr, [x29, #${slot + flag_size_off}]\n`);
	emit_asm(status, `${done_label}:\n`);
	emit_asm(status, `add x0, x29, #${slot}\n`);
}

/** True when the expression is a nullable chain the builders must lower as
 *  a value. */
export function has_null_chain_a64(expr: BaseNode | undefined | null): boolean {
	if (!expr) return false;
	if (expr.node_type === "null_access") return true;
	if (expr.node_type === "access") {
		const an = expr as AccessNode;
		return has_null_chain_a64(an.target);
	}
	return false;
}
