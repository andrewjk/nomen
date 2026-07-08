import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import emit_allocations from "./utils/emit_allocations.ts";

export default function build_while_loop_node(node: WhileLoopNode, status: BuildStatus) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = [];
	const old_deferred_frees = status.deferred_frees;
	status.deferred_frees = [];

	// Hoist allocation declarations from the condition to before the `while`.
	emit_allocations(node.condition, status);

	status.code += `while (`;
	build_node(node.condition, status);
	status.code += `) {\n`;

	build_block_node(node, status);

	if (node.update) {
		status.code += `\t`;
		build_node(node.update, status);
		status.code += `;\n`;
	}

	build_auto_free(status);

	status.code += `}\n`;

	status.scoped_declarations = old_scoped_declarations;
	status.deferred_frees = old_deferred_frees;
}
