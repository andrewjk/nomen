import type BuildStatus from "../build/BuildStatus.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

export default function build_while_loop_node(node: WhileLoopNode, status: BuildStatus) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = [];

	const label = label_counter++;
	const start_label = `.while_${label}`;
	const end_label = `.end_while_${label}`;
	const continue_label = node.update ? `.while_update_${label}` : start_label;

	status.loop_labels = status.loop_labels || [];
	const cleanup_depth = status.heap_cleanup_stack?.length ?? 0;
	status.loop_labels.push({ start: continue_label, end: end_label, cleanup_depth });

	status.code += `${start_label}:\n`;

	// condition
	build_node(node.condition, status);
	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}
	status.code += `cmp x0, #0\n`;
	status.code += `beq ${end_label}\n`;

	// body
	build_block_node(node, status);

	// update clause (e.g. n += 1)
	if (node.update) {
		status.code += `${continue_label}:\n`;
		build_node(node.update, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	status.code += `b ${start_label}\n`;
	status.code += `${end_label}:\n`;

	status.loop_labels.pop();
	status.scoped_declarations = old_scoped_declarations;
}
