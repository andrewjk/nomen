import { get_built_in_type } from "../built_in_types.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type EnumNode from "../nodes/EnumNode.ts";
import type Type from "../nodes/Type.ts";

/**
 * The declaration tables a nullable-scalar classification consults for
 * NON-built-in type names. Both CheckStatus and BuildStatus carry `enums`
 * and `bitsets`, so every call site passes its status straight through.
 */
export interface NullableTypeTables {
	enums: EnumNode[];
	bitsets: { name: string; source_name?: string }[];
}

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
 *
 * The same holds for a nullable SIMPLE enum (`Color?`) or bitset
 * (`Permissions?`): the in-band zero (the first case's tag 0 / an empty
 * bitset) is a real value, so `null` needs the companion flag. Enum-with-data
 * and generic template enums are NOT nullable scalars — the checker rejects
 * `?` on enums with associated data, so every nullable enum that reaches the
 * backends is simple.
 */

/** True if the TYPE NAME is a built-in scalar, simple enum, or bitset — the
 *  shapes that get the `<slot>_has` flag when nullable. */
export function is_nullable_scalar_name(
	name: string | undefined,
	tables: NullableTypeTables,
): boolean {
	if (!name) return false;
	const info = get_built_in_type(name);
	if (info) return info.kind !== "string" && info.kind !== "func";
	// Non-built-in name: a registered simple enum or bitset gets the same
	// flag treatment (`?` on enums with associated data is a checker error).
	const enum_node = tables.enums.findLast(
		(e) => (e.name === name || e.source_name === name) && !e.is_generic,
	);
	if (enum_node) return !enum_node.has_associated_data;
	return tables.bitsets.some((b) => b.name === name || b.source_name === name);
}

/** True if `type` is a nullable built-in scalar, simple enum, or bitset. */
export function is_nullable_scalar_type(
	type: Type | undefined | null,
	tables: NullableTypeTables,
): boolean {
	if (!type?.is_nullable) return false;
	if (type.is_array || type.is_ref || type.storage_kind === "view") return false;
	if (type.is_pointer) return false;
	return is_nullable_scalar_name(type.name, tables);
}

/** Storage width in bytes of the scalar half of a nullable scalar slot. */
export function nullable_scalar_bytes(type: Type): number {
	return get_built_in_type(type.name)?.bytes ?? 8;
}

/** True if `type` is a nullable struct (see nullable_struct.ts) or nullable scalar. */
export function is_nullable_flagged_type(
	type: Type | undefined | null,
	status: NullableTypeTables & {
		structs: { name: string; is_class?: boolean; is_simple_type?: boolean }[];
	},
): boolean {
	if (!type?.is_nullable) return false;
	if (type.name === "string") return false;
	if (type.name === "func") return false;
	return (
		is_nullable_scalar_type(type, status) ||
		!!status.structs.find((s) => s.name === type.name && !s.is_class && !s.is_simple_type)
	);
}
