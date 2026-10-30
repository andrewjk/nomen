import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import { struct_needs_destroy } from "../build_common/destroy_analysis.ts";
import { has_string_fields } from "../build_common/has_string_fields.ts";
import { in_place_push_facts, type InPlacePushFacts } from "../build_common/in_place_push.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type DeclarationNode from "../nodes/DeclarationNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import type Type from "../nodes/Type.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import { emit_free } from "./utils/audit.ts";
import { emit_asm, ensure_newline } from "./utils/code_buffer.ts";
import {
	allocate_stack_space,
	emit_deref_var_address,
	emit_var_address,
	is_local_ref_var,
} from "./utils/stack_var.ts";
import { get_field_offset, get_struct_size } from "./utils/struct_layout.ts";

/**
 * Load a heap `Array<T>` receiver's ELEMENT BASE into x0 — the pointer every
 * Array method call site passes (`[[local]] + 8`: the block's first word is
 * the length). Mirrors the inline .at/.set receiver branches in
 * build_access_node; the in-place store stamps only bare-local receivers, so
 * the param/field-path branches cannot reach here, but the ref-local and
 * heap-local shapes still can.
 */
function emit_array_element_base(status: BuildStatus, name: string): void {
	if (is_local_ref_var(name, status)) {
		emit_deref_var_address(status, "x0", name);
		return;
	}
	if (status.heap_array_vars?.has(name)) {
		emit_var_address(status, "x0", name);
		emit_asm(status, `ldr x0, [x0]\n`);
		emit_asm(status, `add x0, x0, #8\n`);
		return;
	}
	emit_var_address(status, "x0", name);
}

/**
 * The in-place construction guarantee, container-push tranche.
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
	// A `set` stamp re-uses `in_place_push_index` for the value argument —
	// the store lowering claims it first (build_access_node dispatches the
	// store before this), so a kind stamp here means dispatch fell through
	// out of order.
	if (access_func.in_place_store_kind !== undefined) return false;
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
	const { receiver, elem_is_string, list_mono, arg } = facts;
	const slot = emit_reserve_and_slot(status, receiver, list_mono);

	// 3. Construct the argument call's result directly into the slot.
	construct_into_frame_slot(arg, elem_is_string, slot, status);

	// 4. The slot is a real element.
	bump_length(status, receiver, list_mono);
}

/**
 * Step 3, shared by the push and store splices: construct the argument
 * call's result directly into the frame-spilled slot address — the fat
 * string pair stores raw (x0/x1), a value struct takes the sret preset
 * window (x8 = the spilled address; the argument build re-presets it after
 * every nested `bl`). Clears `last_result_is_heap` for strings: the slot
 * owns the buffer now, no caller-side reclaim may fire.
 */
function construct_into_frame_slot(
	arg: BaseNode,
	elem_is_string: boolean,
	slot: number,
	status: BuildStatus,
): void {
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
}

/** Steps 1–2, shared by the direct form and the donor declaration: reserve
 *  one element of capacity, then spill the append slot's address to a frame
 *  slot (a `bl` in the constructing call cannot invalidate it). Returns the
 *  frame offset of the spilled address. The slot address comes from the
 *  container's own `append_slot_ptr` primitive (the same contract every
 *  container declares — List, StableList, user containers). */
function emit_reserve_and_slot(status: BuildStatus, receiver: string, list_mono: string): number {
	// 1. Reserve capacity for the new element. `extra` is push's own policy
	// argument; the `out int` result (the new capacity) is discarded.
	emit_var_address(status, "x0", receiver);
	emit_asm(status, `mov x1, #1\n`);
	emit_asm(status, `bl ${list_mono}_reserve\n`);

	// 2. The destination slot's address — the container's raw append-slot
	// primitive — spilled to the frame.
	emit_var_address(status, "x0", receiver);
	emit_asm(status, `bl ${list_mono}_append_slot_ptr\n`);
	const slot = allocate_stack_space(status, 8);
	emit_asm(status, `str x0, [x29, #${slot}]\n`);
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
	// The container mono name: the checker's generic container name
	// (`List`/`StableList`) plus the element — the same name the receiver
	// resolves to post-monomorphization.
	const list_mono = `${slot_stamp.container}_${elem_type.name}`;
	const elem_is_string = elem_type.name === "string";
	const slot = emit_reserve_and_slot(status, slot_stamp.receiver, list_mono);
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

/**
 * The in-place STORE siblings (`lst.set(i, f(x))`, `buf.set(i, f(x))`,
 * `map.set(k, f(x))`): lower a checker-stamped `set` as
 *
 *     slot := <container>.<slot primitive>(<earlier args>)
 *             — List/Buffer `slot_ptr(i)`; Map `set_slot_ptr(key)` runs the
 *               whole set preamble + probe + insert bookkeeping (or the
 *               displaced reclaim via `values.destroy_at`) first
 *     [slot_ptr kind only: reclaim the displaced value through the slot —
 *      string free + pair zero / guarded T_destroy + stamp clear]
 *     <call> constructed into slot        — sret via x8, or x0/x1 pair store
 *
 * versus the hoisted lowering this replaces: the value argument into a
 * `_param_N` stack temp, the `set` callee's `replace` destroy + deep-copy
 * (a strdup per string field) into the slot, then the temp's scope-exit
 * free. The temp home, the deep copy, and the free all disappear; the
 * displaced-value reclaim stays (it is `set`'s documented overwrite
 * semantic). The earlier arguments (index / key) keep their ordinary
 * lowering and precede the value in evaluation order, so the probe sees
 * them: the key precedes the value end to end.
 *
 * Register discipline: as push — the slot address lives in a FRAME SLOT
 * (a `bl` inside the constructing call cannot invalidate it), scratch is
 * x9-x11, and the sret preset rides `call_x8_preset` /
 * `call_x8_slot_offset`.
 */
export function build_in_place_store(
	node: { target: BaseNode },
	access_func: AccessFunctionCallNode,
	status: BuildStatus,
): boolean {
	const idx = access_func.in_place_push_index;
	const kind = access_func.in_place_store_kind;
	if (idx === undefined || !kind) return false;
	const elem_type: Type | undefined = type_from_value_node(access_func.params[idx]);
	const recv_type = type_from_value_node(node.target);
	const recv_mono = recv_type ? mono_type_name(recv_type) : undefined;
	const facts = in_place_push_facts(
		access_func,
		node.target,
		recv_mono,
		elem_type,
		status.structs as readonly StructNode[],
		!!recv_type?.is_array,
	);
	if (!facts) return false;

	// 1. The destination slot's address: the container's slot primitive
	//    with the earlier arguments (index / key). The receiver's address is
	//    parked in a frame slot while the argument builds run (each build
	//    clobbers x0); each argument's value parks in its own frame slot so
	//    the register loads read them back in call order.
	const recv_slot = allocate_stack_space(status, 8);
	if (facts.receiver_is_array) {
		// A heap Array<T> receiver's ELEMENT BASE: the same computation every
		// Array method call site emits (the local holds the block pointer;
		// the length word precedes the elements).
		emit_array_element_base(status, facts.receiver);
	} else {
		emit_var_address(status, "x0", facts.receiver);
	}
	emit_asm(status, `str x0, [x29, #${recv_slot}]\n`);
	const arg_slots: { slot: number; kind: "scalar" | "string" | "struct" }[] = [];
	for (const early of access_func.params.slice(0, idx)) {
		const t = type_from_value_node(early);
		const kind_of: "scalar" | "string" | "struct" = !t?.name
			? "scalar"
			: t.name === "string" && !t.is_array
				? "string"
				: status.structs.find((s) => s.name === t.name && !s.is_simple_type && !s.is_generic)
					? "struct"
					: "scalar";
		const arg_slot = allocate_stack_space(status, kind_of === "string" ? 16 : 8);
		if (kind_of === "struct") {
			// A struct argument crosses by address; a bare value (the only
			// shape the checker admits — everything else is hoisted to a
			// `_param_N`) is a nameable local.
			emit_var_address(status, "x0", (early as ValueNode).value as string);
		} else {
			build_node(early, status);
			ensure_newline(status);
		}
		if (kind_of === "string") {
			emit_asm(status, `str x0, [x29, #${arg_slot}]\n`);
			emit_asm(status, `str x1, [x29, #${arg_slot + 8}]\n`);
		} else {
			emit_asm(status, `str x0, [x29, #${arg_slot}]\n`);
		}
		arg_slots.push({ slot: arg_slot, kind: kind_of });
	}
	emit_asm(status, `ldr x0, [x29, #${recv_slot}]\n`);
	let reg = 1;
	for (const { slot, kind: arg_kind } of arg_slots) {
		if (arg_kind === "string") {
			emit_asm(status, `ldr x${reg}, [x29, #${slot}]\n`);
			emit_asm(status, `ldr x${reg + 1}, [x29, #${slot + 8}]\n`);
			reg += 2;
		} else {
			emit_asm(status, `ldr x${reg}, [x29, #${slot}]\n`);
			reg += 1;
		}
	}
	const slot = allocate_stack_space(status, 8);
	if (facts.receiver_is_array) {
		// Array: the element address inline — x0 holds the element base, x1
		// the index (the only early argument). No core slot method exists for
		// the builtin array types.
		const elem_stride = facts.elem_is_string ? 16 : get_struct_size(facts.elem_name, status);
		emit_asm(status, `mov x3, #${elem_stride}\n`);
		emit_asm(status, `madd x0, x1, x3, x0\n`);
	} else {
		const prim =
			kind === "set_slot_ptr" ? `${facts.list_mono}_set_slot_ptr` : `${facts.list_mono}_slot_ptr`;
		emit_asm(status, `bl ${prim}\n`);
	}
	emit_asm(status, `str x0, [x29, #${slot}]\n`);

	// 2. The displaced-value reclaim (slot_ptr kind only — Map's primitive
	//    already ran it, one probe earlier, through `values.destroy_at`).
	//    The destroy half of Buffer.replace's specialized body: a string
	//    slot's displaced pointer is freed and the pair zeroed; an owning
	//    value struct's displaced value runs T_destroy, guarded on the `_vt`
	//    constructed stamp (grown-but-unwritten and moved-out slots are
	//    zeroed); a trivially-destructible element needs nothing.
	if (kind === "slot_ptr") {
		if (facts.elem_is_string) {
			const skip = `.Lipds_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
			emit_asm(status, `ldr x10, [x29, #${slot}]\n`);
			emit_asm(status, `ldr x0, [x10]\n`);
			emit_asm(status, `cbz x0, ${skip}\n`);
			emit_free(status);
			emit_asm(status, `ldr x10, [x29, #${slot}]\n`);
			emit_asm(status, `stp xzr, xzr, [x10]\n`);
			emit_asm(status, `${skip}:\n`);
		} else {
			const elem_struct = status.structs.find((s) => s.name === facts.elem_name);
			if (
				elem_struct &&
				(has_string_fields(elem_struct, status) || struct_needs_destroy(elem_struct, status))
			) {
				const skip = `.Lipds_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
				emit_asm(status, `ldr x10, [x29, #${slot}]\n`);
				emit_asm(status, `ldr x9, [x10]\n`);
				emit_asm(status, `cbz x9, ${skip}\n`);
				emit_asm(status, `ldr x0, [x29, #${slot}]\n`);
				emit_asm(status, `bl ${facts.elem_name}_destroy\n`);
				emit_asm(status, `ldr x10, [x29, #${slot}]\n`);
				emit_asm(status, `str xzr, [x10]\n`);
				emit_asm(status, `${skip}:\n`);
			}
		}
	}

	// 3. Construct the value argument's result directly into the slot.
	construct_into_frame_slot(facts.arg, facts.elem_is_string, slot, status);
	return true;
}
