import { get_built_in_type } from "../built_in_types.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type Type from "../nodes/Type.ts";

/**
 * The result `Type` of a call-like node (`func_call`, or a method `access`
 * whose `.access` is an `access_func`), or undefined for anything else.
 * Unlike `type_from_value_node`, an access node's WRAPPER `.type` carries the
 * nullability of the method's result (the inner `access_func.type` may be the
 * bare non-nullable element type).
 */
export function call_result_type(node: BaseNode | undefined | null): Type | undefined {
	if (!node) return undefined;
	if (node.node_type === "func_call") return (node as { type?: Type }).type;
	if (node.node_type === "access") {
		const inner = (node as { access?: { node_type?: string; type?: Type } }).access;
		if (inner?.node_type === "access_func") return inner.type;
	}
	return undefined;
}

/**
 * Nullable scalar support (shared by both backends).
 *
 * A nullable scalar (`bool?`, `int?`, `uint64?`, `float?`, `char?`, …) is
 * stored as the scalar value itself alongside a companion boolean flag named
 * `<slot>_has` (mirroring the nullable-struct convention in
 * `nullable_struct.ts`) — `null` is represented by the flag being 0.
 *
 * Scalars cannot use an in-band representation: `0`/`false` are real values,
 * so `null == 0` conflates them. Nullable `string` (in-band fat zero) and
 * nullable `func`/class values (null pointer) keep their in-band null and
 * are NOT nullable scalars.
 */

/** True if `type` is a nullable built-in scalar (`bool?`, `int?`, `float?`, …). */
export function is_nullable_scalar_type(type: Type | undefined | null): boolean {
	if (!type?.is_nullable) return false;
	if (type.is_array || type.is_ref || type.storage_kind === "view") return false;
	if (type.is_pointer) return false;
	const info = type.name ? get_built_in_type(type.name) : undefined;
	return !!info && info.kind !== "string" && info.kind !== "func";
}

/** Storage width in bytes of the scalar half of a nullable scalar slot. */
export function nullable_scalar_bytes(type: Type): number {
	return get_built_in_type(type.name)?.bytes ?? 8;
}

/** True if `type` is a nullable struct (see nullable_struct.ts) or nullable scalar. */
export function is_nullable_flagged_type(
	type: Type | undefined | null,
	status: { structs: { name: string; is_class: boolean; is_simple_type: boolean }[] },
): boolean {
	if (!type?.is_nullable) return false;
	if (type.name === "string") return false;
	if (type.name === "func") return false;
	return (
		is_nullable_scalar_type(type) ||
		!!status.structs.find((s) => s.name === type.name && !s.is_class && !s.is_simple_type)
	);
}
