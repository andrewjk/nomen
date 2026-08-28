import type { NirStmt } from "../nir/nir.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import build_auto_free from "./build_auto_free.ts";
import type BuildStatus from "./BuildStatus.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import build_condition from "./utils/build_condition.ts";
import { enter_c_scope, leave_c_scope } from "./utils/c_scope.ts";
import emit_allocations from "./utils/emit_allocations.ts";

export default function build_if_else_node(
	node: IfElseNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "if" },
) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = enter_c_scope(status);
	const old_deferred_frees = status.deferred_frees;
	status.deferred_frees = [];

	// Hoist allocation declarations from the condition (e.g. function-call
	// argument temporaries) to before the `if`, since C forbids declarations
	// inside an expression.
	emit_allocations(node.condition, status);

	status.code += `if (`;
	build_condition(node.condition, status);
	status.code += `) {\n`;

	if (node.if_branch) {
		build_block_with_cursor(node.if_branch, nir?.then_branch, status);
		build_auto_free(status);
	}
	leave_c_scope(status);
	if (node.else_branch) {
		status.scoped_declarations = enter_c_scope(status);
		status.deferred_frees = [];
		status.code += `} else {\n`;
		build_block_with_cursor(node.else_branch, nir?.else_branch, status);
		build_auto_free(status);
		leave_c_scope(status);
	}
	status.code += `}\n`;

	status.scoped_declarations = old_scoped_declarations;
	status.deferred_frees = old_deferred_frees;
}
