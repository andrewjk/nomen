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
