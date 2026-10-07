import { mono_type_name } from "../../build_common/mono_name.ts";
import Type from "../../nodes/Type.ts";
import { instantiate_generic_type } from "../check_function_call_node.ts";
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
 *
 * A GENERIC array element (`Box<Cell>[]`, `Array<Box<Cell>>`) flattens here
 * too: the element mono is materialized (existence checks already ran
 * against the generic spelling — name + args — so this is the first point
 * where the mono can be registered), then the element collapses to its
 * monomorphized name and the args drop. Every `"Array_" + elem` container
 * site (checker routing, both backends' layout/mono emission) then keys the
 * same mono struct (`Array_Box_Cell`), instead of the bare generic whose
 * args those sites never read (`Array_Box`).
 */
export default function materialize_type(type: Type, status: CheckStatus): Type {
	if (type.name === "tuple" && type.tuple_types?.length) {
		return materialize_tuple_type(type, status);
	}
	if (type.name === "anon_enum" && type.enum_cases?.length) {
		return materialize_anon_enum_type(type, status);
	}
	if (type.is_array && type.type_args?.length) {
		// For an array type the element is (name + type_args) TOGETHER —
		// `Box<Cell>[]` parses to {name: Box, type_args: [Cell]} where the
		// args belong to the ELEMENT generic. When that element is a generic
		// instantiation, materialize its mono, then collapse the element to
		// the mono name so every `"Array_" + elem` container site keys one
		// mono (`Array_Box_Cell`, not `Array_Box`).
		const elem = new Type(type.name);
		elem.type_args = type.type_args;
		const generic = status.structs.findLast((s) => s.name === elem.name && s.is_generic);
		if (generic && generic.type_params.length === elem.type_args.length) {
			instantiate_generic_type(elem, status);
			const flat = new Type(mono_type_name(elem), type.is_static, type.is_array, type.length);
			flat.storage_kind = type.storage_kind;
			flat.is_ref = type.is_ref;
			flat.is_const_ref = type.is_const_ref;
			flat.is_nullable = type.is_nullable;
			flat.is_array_heap = type.is_array_heap;
			flat.is_view = type.is_view;
			return flat;
		}
	}
	return type;
}
