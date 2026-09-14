import type BaseNode from "../../nodes/BaseNode.ts";
import type FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import type ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";

/**
 * Two-tier trait conformance (shared by the check sites that police it).
 *
 * Tier 1 — trait-typed LOCALS may hold a value-struct conformer inline
 * (`var Rule r = HeadingV()`): no heap, no box; the slot is sized by the
 * initializer's conformer and dispatch is resolved through it. The slot
 * keeps that conformer for its whole lifetime.
 *
 * Tier 2 — every position that crosses a call or container boundary
 * (trait-typed parameters, class fields, collection elements) requires the
 * pointer representation a `class` provides. Value-struct conformers are
 * rejected there (the language does not box implicitly).
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

/** The one error wording for a value-struct conformer in a pointer-representation slot. */
export function value_struct_trait_error(struct_name: string, trait_name: string): string {
	return `value struct '${struct_name}' cannot be used as trait '${trait_name}'; declare '${struct_name}' as a class`;
}

/**
 * The value-struct conformer a trait-typed slot initializer would bind, or
 * undefined when the value doesn't bind a known conformer. A constructor
 * call names its own struct; a bare variable propagates the CONFORMER of
 * the trait slot (or concrete struct) it reads.
 */
export function trait_conformer_of_value(
	value: BaseNode,
	trait_name: string,
	status: CheckStatus,
): string | undefined {
	if (value.node_type === "func_call") {
		const name = (value as FunctionCallNode).type?.name;
		return is_value_struct_conformer(name, trait_name, status) ? name : undefined;
	}
	if (value.node_type === "value") {
		const raw = (value as ValueNode).value;
		if (typeof raw !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return undefined;
		const sv = status.values.findLast((v) => v.name === raw);
		if (sv?.trait_slot_conformer) return sv.trait_slot_conformer;
		const type_name = sv?.type.name ?? (value as ValueNode).type?.name;
		return is_value_struct_conformer(type_name, trait_name, status) ? type_name : undefined;
	}
	return undefined;
}

/**
 * The conformer a trait-typed LOCAL declaration binds (see
 * StackValue.trait_slot_conformer), or undefined when the declaration
 * isn't a trait slot with a value-struct conformer.
 */
export function trait_slot_conformer_of_decl(
	declaration: "const" | "var" | "move",
	type: { name?: string; is_array?: boolean; is_ref?: boolean; is_view?: boolean },
	value: BaseNode | undefined,
	status: CheckStatus,
): string | undefined {
	if (declaration !== "var") return undefined;
	if (!is_trait_type(type.name, status)) return undefined;
	if (type.is_array || type.is_ref || type.is_view) return undefined;
	if (!value) return undefined;
	return trait_conformer_of_value(value, type.name!, status);
}
