import AccessNode from "../../nodes/AccessNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import EnumNode from "../../nodes/EnumNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import GroupedNode from "../../nodes/GroupedNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type BuildStatus from "../BuildStatus.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * Helpers for `==`/`!=` on enums with associated data. Such enums are
 * multi-word values (tag + payload union in C; tag word + packed payload on
 * aarch64), so equality cannot compare whole values — it discriminates on the
 * tag only (the same comparison `match` uses). Payloads are ignored, so
 * `Result.error(1) == Result.error(2)` is true: both are the `error` case.
 */

/** Find the enum-with-associated-data behind either `==`/`!=` operand, if any.
 *  Both operands carry the same enum type (enforced by the check pass). */
export function enum_with_data_side(
	left: BaseNode,
	right: BaseNode,
	status: BuildStatus,
): EnumNode | undefined {
	for (const side of [left, right]) {
		const type = type_from_value_node(side);
		if (type?.name) {
			const enum_node = status.enums.find((e) => e.name === type.name && e.has_associated_data);
			if (enum_node) return enum_node;
		}
	}
	return undefined;
}

/**
 * Extract the case name from an operand that statically references an enum
 * case — `Enum.case`, `Enum.case(args)`, or the checker-rewritten `Enum_case`
 * shorthand forms (with or without args). Returns null for runtime enum
 * values (variables, calls, field accesses) whose tag must be loaded at
 * runtime. Payload args of a case constructor are deliberately NOT built —
 * the tag decides the comparison, so their side effects are dead code.
 */
export function static_enum_case(
	operand: BaseNode,
	enum_node: EnumNode,
	status: BuildStatus,
): string | null {
	if (operand.node_type === "grouped") {
		return static_enum_case((operand as GroupedNode).value, enum_node, status);
	}
	// Checker-rewritten shorthand: `.case` (ValueNode) / `.case(args)`
	// (FunctionCallNode) carry the mangled `Enum_case` string.
	if (operand.node_type === "value" || operand.node_type === "func_call") {
		const shorthand = operand as unknown as ValueNode | FunctionCallNode;
		if (!shorthand.is_enum_shorthand) return null;
		const raw =
			operand.node_type === "value"
				? (operand as ValueNode).value
				: (operand as FunctionCallNode).name;
		if (!raw?.startsWith(enum_node.name + "_")) return null;
		const case_name = raw.substring(enum_node.name.length + 1);
		return enum_node.cases.some((c) => c.name === case_name) ? case_name : null;
	}
	if (operand.node_type === "access") {
		const access = operand as AccessNode;
		// The target must be the enum itself (a case reference), NOT a struct
		// whose field merely has the enum type — that's a runtime value.
		const target = access.target;
		const target_name =
			type_from_value_node(target)?.name ||
			(target.node_type === "value" ? (target as ValueNode).value : undefined);
		if (!target_name || !status.enums.find((e) => e.name === target_name)) return null;
		const inner = access.access as { node_type: string; name?: string };
		if (inner.node_type !== "access_field" && inner.node_type !== "access_func") return null;
		return enum_node.cases.some((c) => c.name === inner.name) ? inner.name! : null;
	}
	return null;
}
