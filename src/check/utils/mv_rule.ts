import { mono_type_name } from "../../build_common/mono_name.ts";
import type Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import {
	is_class_type,
	is_owning_struct_type_requiring_move,
	is_pass_by_value_owning_struct,
} from "./ownership.ts";
import { is_trait_type } from "./trait_slot.ts";

/**
 * The mv-ownership rule (the ownership-spelling rule, enforced at every
 * declaration site): `mv` is legal only for OWNING types — the built-in
 * `string`, class and trait handles, mv structs (declared `mv struct` or
 * inferred, the pass-by-value string-field structs included), and type
 * parameters (ownership unknown until monomorphization). Anything else —
 * ints, plain (Copyable) structs, … — has nothing to transfer, so the
 * marker is rejected with the parameter rule's message. Parameters, struct
 * fields, bindings, and stores all share this predicate.
 *
 * Returns the error message, or undefined when `mv` is legal on the type.
 */
export function mv_type_error(type: Type, status: CheckStatus): string | undefined {
	if (!type.name) return undefined;
	// The built-in `string` is an owner (the fat pair owns its bytes) even
	// outside the appended System library — see check_function_parameter_node.
	if (type.name === "string") return undefined;
	if (is_class_type(type.name, status)) return undefined;
	if (is_trait_type(type.name, status)) return undefined;
	if (is_owning_struct_type_requiring_move(type, status)) return undefined;
	if (is_pass_by_value_owning_struct(type, status)) return undefined;
	// A type parameter is legal: the actual type isn't known until
	// monomorphization (when a generic is instantiated with a non-mv type,
	// mv silently becomes a no-op).
	if (status.type_params.includes(type.name)) return undefined;
	if (status.structs.some((s) => s.type_params.includes(type.name))) return undefined;
	return `mv is only allowed for class, trait, or mv struct types, not '${type.name}'`;
}

/**
 * The ownership-spelling requirement (the flip side of `mv_type_error`):
 * whether a slot of `type` must SPELL `mv` — true for the same owning domain
 * (`string`, class/trait handles, mv structs) minus the implicit cases.
 * Type parameters stay implicit (`var T item` — ownership is unknown until
 * monomorphization, and a substituted `mv T` whose binding owns nothing
 * degrades to a no-op); `ref`/`view` spellings are borrows, not owners;
 * fixed-length arrays own their storage as a unit (the element rule does not
 * apply); func-typed slots carry a return type and the marker there
 * transfers a closure descriptor, which is its own contract.
 */
export function slot_requires_mv(type: Type, status: CheckStatus): boolean {
	if (!type.name || type.name === "func") return false;
	if (type.is_ref || type.is_view || type.is_array) return false;
	if (status.type_params.includes(type.name)) return false;
	if (status.structs.some((s) => s.type_params.includes(type.name))) return false;
	// A generic instantiation whose ARGUMENTS are still parameters
	// (`Buffer<T>` inferred inside a generic body) is param-dependent too —
	// the head type may be a declared-mv struct while the substituted
	// element decides what the slot actually owns — so it stays implicit
	// like a bare param.
	const params = new Set(status.type_params);
	for (const s of status.structs) for (const p of s.type_params) params.add(p);
	const has_param = (t: Type): boolean => {
		if (t.name && params.has(t.name)) return true;
		return !!t.type_args?.some(has_param);
	};
	if (has_param(type)) return false;
	return mv_type_error(type, status) === undefined;
}

/**
 * Whether a type's DECLARATION alone says mv — the shallow form of
 * `slot_requires_mv` for GENERATED fields (tuples, anon structs): it reads
 * only the declared flag (`mv struct`), string-ness, and trait/class
 * registration, not the mono-resolved ownership walk, so it stays correct
 * when a generic instantiation (`List<string>`) has not been monomorphized
 * yet. The generated field must satisfy the requirement when the struct's
 * own check runs later, against the then-registered mono.
 */
export function declares_mv_shallow(type: Type, status: CheckStatus): boolean {
	if (!type.name) return false;
	if (type.name === "string") return true;
	if (status.type_params.includes(type.name)) return false;
	if (is_class_type(type.name, status)) return true;
	if (is_trait_type(type.name, status)) return true;
	const candidates = [type.name];
	if (type.type_args?.length) candidates.push(mono_type_name(type));
	for (const name of candidates) {
		const s = status.structs.find((x) => x.name === name && !x.is_simple_type);
		if (s?.is_owning) return true;
	}
	// Not registered yet: the library's declared-ownership bit answers for
	// the template (`mv struct List<T>` ⇒ every instantiation is owning).
	return !!status.owning_library_types?.has(type.name);
}
