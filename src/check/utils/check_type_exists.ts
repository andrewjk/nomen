import add_error from "../../add_error.ts";
import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import resolve_declared_type from "./resolve_declared_type.ts";
import type_name from "./type_name.ts";

export default function check_type_exists(type: Type, status: CheckStatus, start: number): boolean {
	// Tuple types are validated element-by-element; the auto-generated struct
	// is materialized later (see materialize_tuple_type).
	if (type.name === "tuple" && type.tuple_types?.length) {
		let ok = true;
		for (const elem of type.tuple_types) {
			if (!check_type_exists(elem, status, start)) ok = false;
		}
		return ok;
	}
	// Anonymous enum types are validated case-payload-by-payload; the
	// auto-generated enum is materialized later (see
	// materialize_anon_enum_type). The name "anon_enum" itself is a
	// placeholder, never a registered type.
	if (type.name === "anon_enum" && type.enum_cases?.length) {
		let ok = true;
		for (const c of type.enum_cases) {
			for (const t of c.types) {
				if (!check_type_exists(t, status, start)) ok = false;
			}
		}
		return ok;
	}
	// Resolve to the declaration's emission name so a nested type whose source
	// name was scope-labelled resolves consistently everywhere downstream (the
	// build keys its flat type table by that emission name).
	const declared = resolve_declared_type(type.name, status);
	if (declared) {
		// Visibility gate for type NAMES (not just constructor/field access).
		// An `internal` type may be named only from library code: a reference
		// at/after the library boundary, an enclosing library declaration, or
		// a trusted (`allow_internal`) build. User code naming an internal
		// library type is rejected. `private`/nested visibility is already
		// enforced by resolve_declared_type's emission-scope walk.
		const decl = declared as { visibility?: string; is_library?: boolean };
		// Only gate references that carry a real source offset. Synthesized
		// references (an auto-generated `#init`'s return type, etc.) have no
		// offset and belong to the same unit as their declaration, so they are
		// always allowed.
		const has_source_offset = typeof start === "number" && start > 0;
		if (decl.visibility === "internal" && has_source_offset) {
			const access_is_library =
				start >= (status.library_boundary ?? Number.POSITIVE_INFINITY) ||
				status.stack.some((n) => !!(n as { is_library?: boolean }).is_library) ||
				!!status.allow_internal;
			if (!!decl.is_library !== access_is_library) {
				add_error(status, `Type '${type.name}' is internal to the System library`, start);
				return false;
			}
		}
		type.name = declared.name;
	} else if (!status.types.includes(type.name)) {
		add_error(status, `Unknown type: ${type_name(type)}`, start);
		return false;
	}
	if (type.tuple_types) {
		for (const elem of type.tuple_types) {
			check_type_exists(elem, status, start);
		}
	}
	if (type.type_args) {
		for (const arg of type.type_args) {
			check_type_exists(arg, status, start);
		}
	} else {
		const struct = status.structs.findLast((s) => s.name === type.name);
		if (struct?.is_generic) {
			const all_registered = struct.type_params.every((tp) => status.type_params.includes(tp));
			if (!all_registered) {
				add_error(
					status,
					`Generic type '${type.name}' requires type arguments (expected <${struct.type_params.join(", ")}>)`,
					start,
				);
			}
		} else {
			const enum_node = status.enums.findLast((e) => e.name === type.name);
			if (enum_node?.is_generic) {
				add_error(
					status,
					`Generic type '${type.name}' requires type arguments (expected <${enum_node.type_params.join(", ")}>)`,
					start,
				);
			}
		}
	}
	return true;
}
