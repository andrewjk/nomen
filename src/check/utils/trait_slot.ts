import { collect_expression_branch_values } from "../../build_common/string_return_analysis.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * Trait-object representation (STRUCT_PLAN_3 B4).
 *
 * A trait-typed position — local, parameter, field, container element,
 * return — holds a boxed handle: a heap instance whose first word is the
 * conformer's vtable. A value-struct conformer boxes implicitly; the trait
 * annotation is the marker (T1). Boxing takes ownership (T2): boxing a bare
 * local is a mv (the donor is invalidated), boxing a fresh temporary is
 * free, and borrows/views cannot be boxed. Class conformers box by pointer —
 * the instance is already heap (T4, transition era until Phase R).
 *
 * The former tier-1 inline-local representation is retired: both backends
 * emit handles at every trait position, and the only zero-malloc site left
 * is the bare-parameter calling convention (T3: the caller passes a pointer
 * to a stack copy for the duration of the call).
 */

/** Whether `name` is a declared trait. */
export function is_trait_type(name: string | undefined, status: CheckStatus): boolean {
	return !!name && status.traits.some((t) => t.name === name);
}

/** Whether `name` is a declared VALUE struct (non-class, non-simple). */
export function is_value_struct(name: string | undefined, status: CheckStatus): boolean {
	if (!name) return false;
	const s = status.structs.find((st) => st.name === name);
	return !!s && !s.is_class && !s.is_simple_type;
}

/** Whether the value struct `struct_name` conforms to the trait `trait_name`. */
export function conforms_to_trait(
	struct_name: string,
	trait_name: string,
	status: CheckStatus,
): boolean {
	const s = status.structs.find((st) => st.name === struct_name);
	return !!s && s.traits.includes(trait_name);
}

/** Whether `struct_name` is a value struct that conforms to `trait_name`. */
export function is_value_struct_conformer(
	struct_name: string | undefined,
	trait_name: string,
	status: CheckStatus,
): boolean {
	return (
		!!struct_name &&
		struct_name !== trait_name &&
		is_value_struct(struct_name, status) &&
		conforms_to_trait(struct_name, trait_name, status)
	);
}

/** The one error wording for boxing a value that has no owner to give (T2). */
export function boxing_owns_error(): string {
	return `boxing owns its instance — mv the value, or copy it ('.copy()')`;
}

/**
 * Whether a branching initializer/RHS (match/switch/if — `try/catch` desugars
 * to a match) can box into a trait-typed destination, and under which arm
 * shape: every branch value must be a FRESH temporary (a func_call — the
 * same contract the direct func_call initializer takes; a bare conformer
 * local would byte-share its owned state with the box the join builds) and
 * the branch values must be uniformly ONE type — a single concrete
 * value-struct conformer (the box-at-join shape) or the trait itself (a
 * handle join). Returns the uniform branch type name, or undefined when the
 * shape keeps the boxing rejection.
 */
export function boxable_branch_trait_name(
	rhs: BaseNode,
	trait_name: string,
	status: CheckStatus,
): string | undefined {
	if (rhs.node_type !== "match" && rhs.node_type !== "switch" && rhs.node_type !== "if") {
		return undefined;
	}
	const values = collect_expression_branch_values(rhs);
	if (!values.length) return undefined;
	for (const v of values) {
		if (v.node_type !== "func_call") return undefined;
	}
	const first = type_from_value_node(values[0], status)?.name;
	if (!first) return undefined;
	if (!values.every((v) => type_from_value_node(v, status)?.name === first)) return undefined;
	if (first === trait_name) return first;
	return is_value_struct_conformer(first, trait_name, status) ? first : undefined;
}
