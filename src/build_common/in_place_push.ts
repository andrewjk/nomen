import type BaseNode from "../nodes/BaseNode.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import type Type from "../nodes/Type.ts";

/**
 * GOOSE.md #4 — the in-place construction guarantee, tranche 1: container
 * push. Goose compiles `items.push(parse(line))` so the parsed record is
 * written directly into the new slot — the destination is passed down, no
 * temporary, no copy. Nomen's checker hoists every non-trivial call argument
 * into a `const _param_N` (check_function_call.ts), so even the direct
 * spelling lowered as: call result into a temp home, then the callee-copies
 * `push` memcpys the temp into the slot, then the temp's buffer frees at
 * scope exit. This module carries the shared decision for the tranche-1
 * shape that deletes the temp and the copy in both backends:
 *
 *   reserve(1)                       — List.reserve: growth policy of push
 *   slot := items.data[length]       — the not-yet-pushed element slot
 *   construct <arg call> into slot   — sret (value struct) or x0/x1 store
 *   length += 1                      — the slot is now a real element
 *
 * Soundness rests on the checker stamping `in_place_push_index` ONLY when
 * every one of these holds (see check_function_call.ts):
 *
 * - the receiver is a BARE LOCAL's name (`self_value === self_path`,
 *   resolved to a non-param value of the current function — never a
 *   param, whose by-address spelling differs, never a dotted path);
 * - the argument expression is a direct `func_call` of exactly the element
 *   type, with a body (foreign callees keep the hoisted path), no `ref`
 *   arguments, no swap, no field overrides, and a non-view/non-nullable
 *   return;
 * - every argument OF the argument call is a bare value — a name or
 *   literal — so the argument build emits no `bl`: x8 (the preset sret
 *   destination) cannot be clobbered mid-build, and no argument expression
 *   can re-enter the container. Richer argument trees keep the hoisted
 *   lowering;
 * - the statement's value is discarded (the call is the statement) — push
 *   returns void, so this is the only context that exists;
 * - the element is `string` or a value struct — the classes whose call
 *   results own heap bytes a temp would have freed at scope exit. A class
 *   element rides as a pointer (no copy to elide); scalars aren't worth a
 *   special path.
 *
 * Evaluation order is preserved end to end: reserve runs first (extra
 * capacity is unobservable — count still bumps last), the argument call
 * runs next against the same arguments, and the slot address re-derives
 * from the receiver AFTER the argument call, so a resizing effect anywhere
 * (there is none in the gated shape, but the lowering doesn't rely on it)
 * still stores into the buffer that is current at store time.
 */

/** The value node's bare name when `node` is a `value`, else "". */
function value_name(node: BaseNode | undefined): string {
	if (!node || node.node_type !== "value") return "";
	const value = (node as { value?: unknown }).value;
	return typeof value === "string" ? value : "";
}

/** True for the simple categories whose marshalling never emits a call. */
export function in_place_element_ok(
	type: Type | undefined,
	structs: readonly StructNode[],
): type is Type & { name: string } {
	if (!type?.name) return false;
	if (type.is_view || type.is_array || type.is_ref || type.is_nullable) return false;
	if (type.name === "string") return true;
	const struct = structs.find((s) => s.name === type.name);
	return !!struct && !struct.is_simple_type && !struct.is_class && !struct.is_generic;
}

export interface InPlacePushFacts {
	/** The receiver variable's bare name (`items`). */
	receiver: string;
	/** The element type's mono name (`string`, `Point`, ...). */
	elem_name: string;
	/** True when the element is the fat string (x0/x1 return, 16-byte slot). */
	elem_is_string: boolean;
	/** The mono'd container struct name (`List_string`) — reserve label prefix. */
	list_mono: string;
	/**
	 * The slot-address flavor: `list` derives the slot inline (data +
	 * length * elem_size); `stable` calls the container's raw
	 * `append_slot_ptr` (chunked storage — chunk 0, then directory slabs).
	 */
	flavor: "list" | "stable";
	/** The argument call to construct into the slot. */
	arg: FunctionCallNode;
}

/**
 * Re-derive the mechanical facts for a stamped push call. Returns undefined
 * for a node without the stamp (the caller keeps the normal lowering — the
 * checker only skips the hoist when this will resolve).
 */
export function in_place_push_facts(
	access: { in_place_push_index?: number; params?: BaseNode[] },
	target: BaseNode,
	receiver_type_name: string | undefined,
	elem_type: Type | undefined,
	structs: readonly StructNode[],
): InPlacePushFacts | undefined {
	const idx = access.in_place_push_index;
	if (idx === undefined) return undefined;
	const receiver = value_name(target);
	if (!receiver || !receiver_type_name) return undefined;
	const arg = access.params?.[idx];
	if (!arg || arg.node_type !== "func_call") return undefined;
	if (!elem_type?.name || !in_place_element_ok(elem_type, structs)) return undefined;
	return {
		receiver,
		elem_name: elem_type.name,
		elem_is_string: elem_type.name === "string",
		list_mono: receiver_type_name,
		flavor: receiver_type_name.startsWith("StableList") ? "stable" : "list",
		arg: arg as FunctionCallNode,
	};
}
