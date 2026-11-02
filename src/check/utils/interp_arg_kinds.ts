import { get_built_in_type } from "../../built_in_types.ts";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * Writer-form interpolation (PERF_PLAN items 10/8 remainder): a `\{expr}`
 * whose expression is a NUMERIC scalar no longer lowers through
 * `<expr>.to_string()` (one malloc per argument). The checker strips the wrap
 * and the helper's name gains a per-argument KIND suffix —
 * `_string_interpolate_<arity>_<kinds>` — where each kind is one of:
 *
 *   s — a fat string pair (the only kind the unsuffixed helpers take),
 *   i — a signed int (any signed int family; the value rides one slot),
 *   u — an unsigned int (any uint family),
 *   f — a float (every float family is a 64-bit double; raw bits in a slot).
 *
 * The mixed helpers render each numeric argument into their own frame scratch
 * (the `append_int` digit loop; ONE `%f` snprintf per float — the item's
 * hand-rolled-`%f` exclusion) and the copy walk then treats every argument as
 * a (ptr, len) pair — the all-string walk, unchanged. All-string calls keep
 * the unsuffixed name, so every existing shape (and the system TU's
 * pre-emitted arities 1..7) is untouched.
 *
 * The suffix rides the NAME rather than the pattern: a pattern-encoded kind
 * would reintroduce the literal-`%` ambiguity the item-10 fix removed (a
 * literal "100% d" would become a directive). Mixed helpers are per-TU-local
 * (never .globl'd / C-static) because the system TU cannot enumerate kind
 * mixes — a user TU's mix resolves against its own local definition, exactly
 * like arities past 7.
 */

export type InterpKind = "s" | "i" | "u" | "f";

export const INTERP_PREFIX = "_string_interpolate_";

/** Whether `name` is a (possibly suffixed) interpolation helper name. */
export function is_interp_name(name: string): boolean {
	return name.startsWith(INTERP_PREFIX);
}

/** Parse an interpolation helper name: the arity digits right after the
 *  prefix, then the optional `_kinds` suffix. `kinds` is null for the
 *  unsuffixed (all-string) form. */
export function parse_interp_name(name: string): { arity: number; kinds: string[] | null } {
	const rest = name.substring(INTERP_PREFIX.length);
	const arity = parseInt(rest, 10);
	const underscore = rest.indexOf("_");
	if (underscore === -1 || Number.isNaN(arity)) return { arity, kinds: null };
	const kinds = rest.substring(underscore + 1).split("");
	return { arity, kinds };
}

/** Build a suffixed helper name from the per-argument kinds. */
export function build_interp_name(arity: number, kinds: string[]): string {
	return `${INTERP_PREFIX}${arity}_${kinds.join("")}`;
}

export interface InterpArgRewrite {
	/** The argument's kind — null when the arg keeps the string lowering
	 *  (not the `.to_string()` wrap shape, or the wrapped target is not a
	 *  numeric scalar: strings, bools, chars, structs keep their real
	 *  `to_string` bodies). */
	kind: InterpKind | null;
	/** The node the writer-form lowering passes: the wrap's target (the
	 *  numeric expression itself). Null when kind is null. */
	target: BaseNode | null;
}

/** Classify an interpolation ARGUMENT node — the node as the parse layer
 *  built it (wrapped in `.to_string()` unless the source already spelled the
 *  conversion). Called after the argument has been checked, so the wrapped
 *  target's stamped type is readable. */
export function interp_arg_rewrite(param: BaseNode, status: CheckStatus): InterpArgRewrite {
	const none: InterpArgRewrite = { kind: null, target: null };
	if (param.node_type !== "access") return none;
	const access = (param as AccessNode).access;
	if (!access || access.node_type !== "access_func") return none;
	if ((access as AccessFunctionCallNode).name !== "to_string") return none;
	const target = (param as AccessNode).target;
	if (!target) return none;
	const t = type_from_value_node(target, status);
	// A container TYPE carries its ELEMENT's name (`Array(1, 2, 3)` is
	// `Type{ name: "int", is_array: true }`), so the built-in lookup alone
	// would mistake an int array for an int. Only a bare scalar target is a
	// numeric argument.
	if (t.is_array || t.is_view || t.is_ref || t.is_pointer) return none;
	const info = get_built_in_type(t.name);
	if (!info) return none;
	if (info.kind === "float") return { kind: "f", target };
	if (info.kind !== "int") return none;
	return { kind: info.signed ? "i" : "u", target };
}
