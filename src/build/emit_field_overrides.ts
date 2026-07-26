import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ValueNode from "../nodes/ValueNode.ts";

/**
 * Build the post-construction field-override assignments for a named-field
 * struct literal (e.g. `[ grow = 2 ]` on a struct whose auto-`#init` has no
 * `grow` param). Each override becomes a synthetic `<var>.<field> = <value>`
 * AssignmentNode and is fed through the supplied `build` callback (the
 * per-backend build_node), so primitives, classes, struct-typed fields, and
 * strings all reuse the existing assignment path.
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
	const ctor = value as FunctionCallNode;
	if (!ctor.field_overrides?.length) return;
	status.code += declaration_terminator;
	for (const override of ctor.field_overrides) {
		const target = new ValueNode(override.value.start, var_name);
		const access_field = new AccessFieldNode(override.value.start, override.name, override.type);
		const access = new AccessNode(override.value.start, target, access_field);
		const assign = new AssignmentNode(override.value.start, access, override.value);
		status.code += "\n";
		build(assign, status);
		status.code += statement_terminator;
	}
}
