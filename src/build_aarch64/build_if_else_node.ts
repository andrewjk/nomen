import type BuildStatus from "../build_c/BuildStatus.ts";
import type { NirStmt } from "../nir/nir.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import { emit_cond_branch } from "./build_operation_node.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import { enter_scope_frame, exit_scope_frame } from "./utils/auto_destroy.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

/** Allocate the next if-statement label number (shared with the NIR-driven
 *  emission path so both produce identical label numbering). */
export function next_if_label(): number {
	return label_counter++;
}

export default function build_if_else_node(
	node: IfElseNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "if" },
) {
	const label = next_if_label();
	const old_scoped_declarations = enter_scope_frame(status);

	// Branch-aware condition lowering: comparisons branch directly off the
	// operand `cmp` instead of materializing a 0/1 into x0 first.
	emit_cond_branch(
		node.condition,
		node.else_branch ? `else_${label}` : `end_${label}`,
		false,
		status,
	);
	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}

	// Snapshot the Buffer data-pointer cache before the conditional so each
	// branch starts from the dominating (pre-branch) state. A cache entry
	// loaded inside one branch is dropped on restore, which is sound: it is
	// not valid in a sibling branch that may not have executed the load.
	const pre_cache = status.buffer_data_cache;

	if (node.else_branch) {
		status.buffer_data_cache = new Map(pre_cache);
		build_block_with_cursor(node.if_branch!, nir?.then_branch, status);
		status.code += `b end_${label}\n`;
		status.code += `else_${label}:\n`;
		status.buffer_data_cache = new Map(pre_cache);
		build_block_with_cursor(node.else_branch, nir?.else_branch, status);
	} else {
		if (node.if_branch) {
			status.buffer_data_cache = new Map(pre_cache);
			build_block_with_cursor(node.if_branch, nir?.then_branch, status);
		}
	}

	status.buffer_data_cache = pre_cache;

	status.code += `end_${label}:\n`;

	exit_scope_frame(status, old_scoped_declarations);
}
