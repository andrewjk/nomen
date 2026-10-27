import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { in_place_push_facts, type InPlacePushFacts } from "../build_common/in_place_push.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type DeclarationNode from "../nodes/DeclarationNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import type Type from "../nodes/Type.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import { emit_asm, ensure_newline } from "./utils/code_buffer.ts";
import { allocate_stack_space, emit_var_address } from "./utils/stack_var.ts";
import { get_field_offset, get_struct_size } from "./utils/struct_layout.ts";

/**
 * GOOSE.md #4 — the in-place construction guarantee, container-push tranche.
 *
 * Lowers a checker-stamped `items.push(<call>)` as:
 *
 *     bl List_<T>_reserve(&items, 1)     — growth, exactly push's policy
 *     slot := [items.items.data + length * elem_size]   — spilled to a frame
 *     <call> constructed into slot       — sret via x8, or x0/x1 pair store
 *     items.length += 1
 *
 * versus the hoisted lowering this replaces: the call result into a
 * `_param_N` stack temp, `bl List_<T>_push` whose callee-copies `mv value`
 * memcpys the temp into the slot, then the temp's scope-exit free. The temp
 * home, the struct copy, and the free all disappear; the slot store that
 * remains is the one store Goose's model also performs (the callee writes
 * the caller's memory).
 *
 * Register discipline: every scratch here (x9-x11) dies before the argument
 * build, and the slot address lives in a FRAME SLOT — a `bl` inside the
 * argument call cannot invalidate it, so the store re-derives nothing and
 * the length bump re-derives the receiver from its name. The sret preset
 * rides the existing declaration-initializer protocol (`call_x8_preset`);
 * `call_x8_slot_offset` extends its post-`bl` re-preset to a spilled
 * address, since the destination is not a nameable local.
 */
export function build_in_place_push(
	node: { target: BaseNode },
	access_func: AccessFunctionCallNode,
	status: BuildStatus,
): boolean {
	const idx = access_func.in_place_push_index;
	if (idx === undefined) return false;
	const elem_type: Type | undefined = type_from_value_node(access_func.params[idx]);
	const recv_type = type_from_value_node(node.target);
	// The receiver's value-node type can still carry the GENERIC name (`List`)
	// at build time — the mono name is what the reserve label, the field
	// offsets and the Buffer element layout are computed against.
	const recv_mono = recv_type ? mono_type_name(recv_type) : undefined;
	const facts = in_place_push_facts(
		access_func,
		node.target,
		recv_mono,
		elem_type,
		status.structs as readonly StructNode[],
	);
	if (!facts) return false;
	emit_in_place_push(facts, status);
	return true;
}

function emit_in_place_push(facts: InPlacePushFacts, status: BuildStatus): void {
	const { receiver, elem_name, elem_is_string, list_mono, arg } = facts;
	const slot = emit_reserve_and_slot(status, receiver, list_mono, elem_name, elem_is_string);

	// 3. Construct the argument call's result directly into the slot.
	if (elem_is_string) {
		// Fat strings return in x0/x1 (no sret): store the pair into the slot.
		build_node(arg, status);
		ensure_newline(status);
		emit_asm(status, `ldr x10, [x29, #${slot}]\n`);
		emit_asm(status, `str x0, [x10]\n`);
		emit_asm(status, `str x1, [x10, #8]\n`);
		// The slot owns the buffer now — no caller-side reclaim may fire.
		status.last_result_is_heap = false;
	} else {
		// Value structs return through x8 sret: preset the slot as the
		// destination, exactly like a struct-typed declaration initializer.
		const old_preset = status.call_x8_preset;
		const old_var = status.struct_return_buffer_var;
		const old_slot = status.call_x8_slot_offset;
		emit_asm(status, `ldr x8, [x29, #${slot}]\n`);
		status.call_x8_preset = true;
		status.call_x8_slot_offset = slot;
		build_node(arg, status);
		status.call_x8_preset = old_preset;
		status.struct_return_buffer_var = old_var;
		status.call_x8_slot_offset = old_slot;
	}

	// 4. The slot is a real element.
	bump_length(status, receiver, list_mono);
}

/** Steps 1–2, shared by the direct form and the donor declaration: reserve
 *  one element of capacity, then spill the fresh slot's address to a frame
 *  slot (a `bl` in the constructing call cannot invalidate it). Returns the
 *  frame offset of the spilled address. */
function emit_reserve_and_slot(
	status: BuildStatus,
	receiver: string,
	list_mono: string,
	elem_name: string,
	elem_is_string: boolean,
): number {
	const elem_size = elem_is_string ? 16 : get_struct_size(elem_name, status);
	const items_off = get_field_offset(list_mono, "items", status);
	const length_off = get_field_offset(list_mono, "length", status);
	const buffer_mono = `Buffer_${elem_name}`;
	const data_off = items_off + get_field_offset(buffer_mono, "data", status);

	// 1. Reserve capacity for the new element. `extra` is push's own policy
	// argument; the `out int` result (the new capacity) is discarded.
	emit_var_address(status, "x0", receiver);
	emit_asm(status, `mov x1, #1\n`);
	emit_asm(status, `bl ${list_mono}_reserve\n`);

	// 2. The destination slot's address, spilled to the frame.
	emit_var_address(status, "x9", receiver);
	ensure_newline(status);
	emit_asm(status, `ldr x10, [x9, #${data_off}]\n`);
	emit_asm(status, `ldr x11, [x9, #${length_off}]\n`);
	const shift = Math.log2(elem_size);
	if (Number.isInteger(shift)) {
		emit_asm(status, `lsl x11, x11, #${shift}\n`);
	} else {
		emit_asm(status, `mov x12, #${elem_size}\n`);
		emit_asm(status, `mul x11, x11, x12\n`);
	}
	emit_asm(status, `add x11, x10, x11\n`);
	const slot = allocate_stack_space(status, 8);
	emit_asm(status, `str x11, [x29, #${slot}]\n`);
	return slot;
}

/** Step 4: the slot is a real element. */
function bump_length(status: BuildStatus, receiver: string, list_mono: string): void {
	const length_off = get_field_offset(list_mono, "length", status);
	emit_var_address(status, "x9", receiver);
	ensure_newline(status);
	emit_asm(status, `ldr x10, [x9, #${length_off}]\n`);
	emit_asm(status, `add x10, x10, #1\n`);
	emit_asm(status, `str x10, [x9, #${length_off}]\n`);
}

/**
 * The donor form's DECLARATION (`var p = <call of T>` stamped by the
 * checker because the next statement is `items.push(mv p)`): reserve the
 * slot, construct the initializer's result into it, and materialize
 * NOTHING for the binding — no frame home, no anchors, no string-field
 * records, no scope-exit free. The push statement supplies the bump.
 */
export function build_in_place_donor_declaration(
	node: DeclarationNode,
	status: BuildStatus,
): boolean {
	const slot_stamp = node.in_place_push_slot;
	if (!slot_stamp || !node.value || node.value.node_type !== "func_call") return false;
	const elem_type = type_from_value_node(node.value);
	if (!elem_type?.name) return false;
	// The container mono name derives from the element (`List_string`) — the
	// same name the checker's receiver resolves to post-monomorphization.
	const list_mono = `List_${elem_type.name}`;
	const elem_is_string = elem_type.name === "string";
	const slot = emit_reserve_and_slot(
		status,
		slot_stamp.receiver,
		list_mono,
		elem_type.name,
		elem_is_string,
	);
	if (elem_is_string) {
		build_node(node.value, status);
		ensure_newline(status);
		emit_asm(status, `ldr x10, [x29, #${slot}]\n`);
		emit_asm(status, `str x0, [x10]\n`);
		emit_asm(status, `str x1, [x10, #8]\n`);
		status.last_result_is_heap = false;
	} else {
		const old_preset = status.call_x8_preset;
		const old_var = status.struct_return_buffer_var;
		const old_slot = status.call_x8_slot_offset;
		emit_asm(status, `ldr x8, [x29, #${slot}]\n`);
		status.call_x8_preset = true;
		status.call_x8_slot_offset = slot;
		build_node(node.value, status);
		status.call_x8_preset = old_preset;
		status.struct_return_buffer_var = old_var;
		status.call_x8_slot_offset = old_slot;
	}
	return true;
}

/**
 * The donor form's PUSH: the declaration already constructed the element,
 * so this statement is just the length bump.
 */
export function build_in_place_donor_bump(
	node: { target: BaseNode },
	status: BuildStatus,
): boolean {
	if (node.target.node_type !== "value") return false;
	const recv_type = type_from_value_node(node.target);
	const list_mono = recv_type ? mono_type_name(recv_type) : undefined;
	if (!list_mono) return false;
	bump_length(status, (node.target as ValueNode).value as string, list_mono);
	return true;
}
