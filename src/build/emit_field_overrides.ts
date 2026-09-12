import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import type AnonStructNode from "../nodes/AnonStructNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ValueNode from "../nodes/ValueNode.ts";

/**
 * The validated override list, in either shape it arrives: `field_overrides`
 * on a constructor call (`T(...) + [ ... ]` collapsed at parse time) or the
 * typed `fields` of a base-bearing AnonStructNode (`[ .. <base>, ... ]`).
 */
type OverrideList = { field_overrides?: { name: string; value: BaseNode; type?: unknown }[] };

function overrides_of(value: BaseNode): { name: string; value: BaseNode; type?: unknown }[] {
	const call = value as FunctionCallNode;
	if (call.field_overrides?.length) return call.field_overrides;
	return (value as AnonStructNode).fields as {
		name: string;
		value: BaseNode;
		type?: unknown;
	}[];
}

/**
 * Build the post-construction field-override assignments for a named-field
 * struct literal (e.g. `[ grow = 2 ]` on a struct whose `grow` field has a
 * declared default, or `[ .. <base>, grow = 2 ]`). Each override becomes a
 * synthetic `<var>.<field> = <value>` AssignmentNode and is fed through the
 * supplied `build` callback (the per-backend build_node), so primitives,
 * classes, struct-typed fields, and strings all reuse the existing assignment
 * path.
 *
 * `declaration_terminator` is appended once before the overrides (e.g. `;\n`
 * for C) so the just-emitted declaration is properly closed before the
 * synthetic assignments begin. `statement_terminator` is appended after each
 * synthetic assignment (e.g. `;\n` for C; asm uses the empty string since
 * each emitted instruction is already line-terminated).
 */
export default function emit_field_overrides(
	var_name: string,
	value: BaseNode,
	build: (node: BaseNode, status: any) => void,
	status: any,
	declaration_terminator = "",
	statement_terminator = "",
) {
	const overrides = overrides_of(value);
	if (!overrides.length) return;
	status.code += declaration_terminator;
	for (const override of overrides) {
		const target = new ValueNode(override.value.start, var_name);
		const access_field = new AccessFieldNode(override.value.start, override.name, override.type as any);
		const access = new AccessNode(override.value.start, target, access_field);
		const assign = new AssignmentNode(override.value.start, access, override.value);
		status.code += "\n";
		build(assign, status);
		status.code += statement_terminator;
	}
}

/**
 * True when `value` carries field overrides to apply after the destination
 * slot has been written: a constructor call with `field_overrides`, or a
 * base-bearing anonymous struct literal (`[ .. <base>, ... ]`).
 */
export function has_field_overrides(value: BaseNode | undefined | null): boolean {
	if (!value) return false;
	if (value.node_type === "func_call") {
		return !!(value as FunctionCallNode).field_overrides?.length;
	}
	if (value.node_type === "anon_struct") {
		return !!(value as AnonStructNode).base;
	}
	return false;
}
