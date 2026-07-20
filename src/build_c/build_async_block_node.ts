import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import build_block_node from "./build_block_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/**
 * Build an `async { ... }` nursery block.
 *
 * Emits a scope with a fixed-capacity handle array. Spawns inside the block
 * (detected via status.nursery_stack) push to the array instead of detaching.
 * At block exit, the nursery joins every handle.
 *
 * v1: fixed capacity (64 tasks per nursery). Exceeding it is undefined
 * behavior — a real implementation would grow or use a linked list.
 */
export default function build_async_block_node(node: AsyncBlockNode, status: BuildStatus) {
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	const handles_name = `__echo_nursery_${id}_handles`;
	const count_name = `__echo_nursery_${id}_count`;
	const idx_name = `__echo_nursery_${id}_i`;

	status.code += `{\n`;
	status.code += `\tpthread_t ${handles_name}[64];\n`;
	status.code += `\tint ${count_name} = 0;\n`;

	status.nursery_stack ??= [];
	status.nursery_stack.push(id);

	build_block_node(node, status);

	status.nursery_stack.pop();

	status.code += `\tfor (int ${idx_name} = 0; ${idx_name} < ${count_name}; ${idx_name}++) {\n`;
	status.code += `\t\tvoid *_ret;\n`;
	status.code += `\t\tpthread_join(${handles_name}[${idx_name}], &_ret);\n`;
	status.code += `\t}\n`;
	status.code += `}\n`;
}
