import add_error from "../../add_error.ts";
import {
	is_nullable_flagged_type,
	is_nullable_scalar_name,
} from "../../build_common/nullable_scalar.ts";
import built_in_types from "../../built_in_types.ts";
import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import { resolve_case_enum_type } from "./case_enum.ts";
import is_visible from "./is_visible.ts";
import { accessor_context, decl_namespace } from "./namespaces.ts";
import resolve_declared_type from "./resolve_declared_type.ts";
import type_name from "./type_name.ts";

/**
 * Containers whose elements live in raw T-sized slots (the `#arch` generic
 * bodies size each slot from the type name alone). A flagged-nullable
 * element type (`List<int?>`) has no per-slot null flag there, so `0`/`false`
 * would read back as null — rejected instead of silently misbehaving.
 * Element types with an in-band null (`string?`, class/trait `?`) stay legal.
 */
const RAW_ELEMENT_CONTAINERS = new Set([
	"Array",
	"Buffer",
	"List",
	"Set",
	"Map",
	"Graph",
	"LinkedList",
	"Tree",
	"Arena",
]);

export default function check_type_exists(type: Type, status: CheckStatus, start: number): boolean {
	// A raw `T[]`/`T[N]` array (or the parse-rewritten `Array<T>` heap form,
	// whose type carries the ELEMENT's name + nullability) with a
	// flagged-nullable element: element slots carry no null flag, so
	// `int?[]` would read 0 back as null. Rejected instead.
	if (
		type.is_nullable &&
		type.is_array &&
		!type.is_ref &&
		!type.is_pointer &&
		is_nullable_scalar_name(type.name, status)
	) {
		add_error(
			status,
			`Nullable element type '${type.name}?' is not supported in an array: element storage has no per-element null flag`,
			start,
		);
	}
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
		// `?` on a payload-carrying anon enum: the tag word conflates null
		// with the first case, and a flag slot would need full data-enum
		// nullable support. Rejected up front.
		if (type.is_nullable && type.enum_cases.some((c) => c.types.length > 0)) {
			add_error(
				status,
				`Nullable type '${type_name(type)}' is not supported: enums with associated data have no separate null flag`,
				start,
			);
		}
		let ok = true;
		for (const c of type.enum_cases) {
			for (const t of c.types) {
				if (!check_type_exists(t, status, start)) ok = false;
			}
		}
		return ok;
	}
	// Variable-mode enum (PERF_PLAN item 13): a case-qualified type
	// (`Res.ok`) validates its base enum + case and materializes the
	// single-case mono (`Res_ok`) into the type tables. Afterwards the
	// mangled name resolves like any declared type below.
	if (type.case_enum) {
		resolve_case_enum_type(type, status, start);
	}
	// Resolve to the declaration's emission name so a nested type whose source
	// name was scope-labelled resolves consistently everywhere downstream (the
	// build keys its flat type table by that emission name).
	const declared = resolve_declared_type(type.name, status);
	if (declared) {
		// Visibility gate for type NAMES (not just constructor/field access)
		// (docs/SCOPING.md): the referencing file must reach the declaring
		// namespace — its own, an ancestor, or an import; `internal` types
		// may only be named from that namespace or its descendants; unmarked
		// types only from the namespace itself. Synthesized references (an
		// auto-generated `#init`'s return type, etc.) carry no source offset
		// and always pass, and trusted (`allow_internal`) builds keep
		// pre-scoping access to library internals.
		const has_source_offset = typeof start === "number" && start > 0;
		// Compiler-synthesized types (tuples, anonymous structs) belong to no
		// namespace — never gate them (the name-prefix idiom used across the
		// checker, e.g. copy_synthesis).
		const is_synthesized = type.name.startsWith("_Tuple_") || type.name.startsWith("_Anon_");
		const is_builtin = built_in_types.includes(type.name);
		const ctx =
			has_source_offset &&
			!is_synthesized &&
			!is_builtin &&
			!status.allow_internal &&
			// A monomorphized body's substituted type arguments were gated at
			// the call site — the generated body itself is compiler glue.
			!status.is_mono_body_recheck
				? accessor_context(status)
				: undefined;
		if (ctx) {
			const decl_ns = decl_namespace(declared);
			const vis = ((declared as { visibility?: string }).visibility ?? "pub") as
				| "pub"
				| "private"
				| "internal";
			const { ns: accessor_ns, imports } = ctx;
			const key = `${type.name}@${accessor_ns}`;
			if (
				decl_ns !== undefined &&
				!status.reported_scope_errors?.has(key) &&
				!is_visible(decl_ns, vis, accessor_ns, imports)
			) {
				status.reported_scope_errors?.add(key);
				if (vis === "pub") {
					add_error(status, `Namespace ${decl_ns} is not imported: ${type.name}`, start);
				} else {
					add_error(status, `Can't access ${vis} type: ${type.name}`, start);
				}
				return false;
			}
		}
		type.name = declared.name;
		// `?` on a payload-carrying enum: the tag word conflates null with the
		// first case, and a companion flag would need full data-enum nullable
		// support (payload ownership on top of the flag). Rejected up front;
		// simple enums and bitsets ARE nullable (a `<slot>_has` flag).
		if (type.is_nullable) {
			const enum_node = status.enums.findLast(
				(e) => (e.name === declared.name || e.source_name === declared.name) && !e.is_generic,
			);
			if (enum_node?.has_associated_data) {
				add_error(
					status,
					`Nullable type '${type_name(type)}' is not supported: enums with associated data have no separate null flag`,
					start,
				);
			}
		}
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
		// Raw-element container slots carry no per-element null flag (see
		// RAW_ELEMENT_CONTAINERS): reject a flagged-nullable element type.
		if (RAW_ELEMENT_CONTAINERS.has(type.name)) {
			for (const arg of type.type_args) {
				if (is_nullable_flagged_type(arg, status)) {
					add_error(
						status,
						`Nullable element type '${type_name(arg)}' is not supported in '${type.name}<...>': container element storage has no per-element null flag`,
						start,
					);
				}
			}
		}
		for (const arg of type.type_args) {
			// A func value is a one-word closure descriptor; containers and
			// other generic instantiations have no layout for one
			// (CLOSURE.md restrictions). `Func<...>` IS the func type — it
			// desugars in the parser and never reaches here as a generic.
			if (arg.name === "func") {
				add_error(
					status,
					`func types cannot be used as type arguments ('${type.name}<...>')`,
					start,
				);
				continue;
			}
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
