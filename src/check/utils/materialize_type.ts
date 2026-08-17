import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import { materialize_anon_enum_type } from "./anon_enum.ts";
import { materialize_tuple_type } from "./tuple_struct.ts";

/**
 * Materialize a composite annotation type in place-safe fashion: tuple types
 * `[T1, T2]` become their generated struct type, and anonymous enum types
 * `[.ok(T), .error]` become their generated enum type. Any other type is
 * returned unchanged. This is the single dispatch point used by every
 * annotation site (declarations, params, return types) so both composite
 * forms behave identically everywhere a type can be written.
 */
export default function materialize_type(type: Type, status: CheckStatus): Type {
	if (type.name === "tuple" && type.tuple_types?.length) {
		return materialize_tuple_type(type, status);
	}
	if (type.name === "anon_enum" && type.enum_cases?.length) {
		return materialize_anon_enum_type(type, status);
	}
	return type;
}
