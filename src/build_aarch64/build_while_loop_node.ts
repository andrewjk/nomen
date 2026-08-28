import type BuildStatus from "../build_c/BuildStatus.ts";
import type { NirStmt } from "../nir/nir.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import { emit_cond_branch } from "./build_operation_node.ts";
import { enter_scope_frame, exit_scope_frame } from "./utils/auto_destroy.ts";
import { promote_loop_locals, type PromotedVar } from "./utils/loop_promotion.ts";
import { emit_promoted_store } from "./utils/stack_var.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

/** Allocate the next while-loop label number (shared with the NIR-driven
 *  emission path so both produce identical label numbering). */
export function next_while_label(): number {
	return label_counter++;
}

export default function build_while_loop_node(
	node: WhileLoopNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "while" },
) {
	const old_scoped_declarations = enter_scope_frame(status);

	const label = next_while_label();
	const start_label = `.while_${label}`;
	const end_label = `.end_while_${label}`;
	const continue_label = node.update ? `.while_update_${label}` : start_label;

	status.loop_labels = status.loop_labels || [];
	const cleanup_depth = status.heap_cleanup_stack?.length ?? 0;
	status.loop_labels.push({
		start: continue_label,
		end: end_label,
		cleanup_depth,
	});

	const promoted: PromotedVar[] = [];
	const saved_reg_allocs = status.register_allocations
		? new Map(status.register_allocations)
		: undefined;
	const saved_buffer_cache = status.buffer_data_cache;
	status.buffer_data_cache = undefined;

	if (status.function_return_label && node.statements.length > 0) {
		promoted.push(
			...promote_loop_locals(status, old_scoped_declarations, {
				condition: node.condition,
				statements: node.statements,
				update: node.update,
			}),
		);
	}

	// (String `.length` is a load of the fat string's len half — no
	// strlen hoisting is needed anymore.)

	status.code += `${start_label}:\n`;

	const is_always_true =
		node.condition.node_type === "value" && (node.condition as any).value === "true";

	if (!is_always_true) {
		// Branch-aware condition lowering: comparisons branch directly off
		// the operand `cmp` instead of materializing a 0/1 into x0 first.
		emit_cond_branch(node.condition, end_label, false, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	build_loop_body_block(node, nir?.body, status);

	if (node.update) {
		status.code += `${continue_label}:\n`;
		build_node(node.update, status);
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}

	status.code += `b ${start_label}\n`;
	status.code += `${end_label}:\n`;

	for (const p of promoted) {
		// Store back with the slot's width — a full-width `str` into a
		// sub-word slot would clobber the adjacent stack bytes.
		emit_promoted_store(status, p.reg, p.offset, p.type_name);
	}

	if (saved_reg_allocs) {
		status.register_allocations = saved_reg_allocs;
	} else {
		status.register_allocations = undefined;
	}

	status.buffer_data_cache = saved_buffer_cache;

	status.loop_labels.pop();
	exit_scope_frame(status, old_scoped_declarations);
}

/** Build a loop body block, pointing the NIR emission cursor at the loop's
 *  lowered body statements when available (and clearing it when not — a
 *  delegated loop must never let its body consume an enclosing block's
 *  cursor, even though the identity guard would catch it). */
export function build_loop_body_block(
	node: BlockNode,
	stmts: readonly NirStmt[] | undefined,
	status: BuildStatus,
) {
	const old_ctx = status.nir_emit_ctx;
	status.nir_emit_ctx = stmts ? { stmts, ast: node.statements } : undefined;
	build_block_node(node, status);
	status.nir_emit_ctx = old_ctx;
}
