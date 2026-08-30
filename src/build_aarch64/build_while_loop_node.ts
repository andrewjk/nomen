import type BuildStatus from "../build_c/BuildStatus.ts";
import type { NirStmt } from "../nir/nir.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import build_node from "./build_node.ts";
import { emit_cond_branch } from "./build_operation_node.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import { emit_neon_vector_loop } from "./neon_emit.ts";
import type { NeonPlan } from "./neon_plan.ts";
import { enter_scope_frame, exit_scope_frame } from "./utils/auto_destroy.ts";
import { promote_loop_locals, type PromotedVar } from "./utils/loop_promotion.ts";
import { emit_promoted_store, emit_var_store } from "./utils/stack_var.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

/** Allocate the next while-loop label number (shared with the NIR-driven
 *  emission path so both produce identical label numbering). */
export function next_while_label(): number {
	return label_counter++;
}

/** The induction name for this while (left leaf of the `<` condition). */
function node_condition_name(node: WhileLoopNode): string {
	const cond = node.condition as unknown as { left_value?: { value?: string }; value?: string };
	return (cond.left_value?.value as string) ?? (cond.value as string) ?? "";
}

function mov_immediate_x0_and_store(status: BuildStatus, name: string, value: number): void {
	status.code += `mov x0, #${value}\n`;
	emit_var_store(status, "x0", name, 8);
}

export default function build_while_loop_node(
	node: WhileLoopNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "while" },
	vector?: NeonPlan | null,
	unroll_count?: number | null,
) {
	const old_scoped_declarations = enter_scope_frame(status);

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

	let pushed_labels = false;
	if (unroll_count !== null && unroll_count !== undefined) {
		// Full unrolling (ASM_PLAN_2 tranche A): the plan guarantees the trip
		// count is exact (literal bound, 0-init, +1 step), the body never
		// reads the induction, and no break/continue targets this loop — so
		// the body is emitted N straight times and the loop machinery
		// (counter, compare, branch, labels) disappears. Each copy rides the
		// NIR cursor; promotion above keeps body floats in registers across
		// copies. Computed only under an active NIR cursor (see
		// emit_stmt_from_nir), so the AST/byte-identity path never sees it.
		// Index-substitution mode (tranche E): the body READS the
		// induction as an array index — per copy, reads of the induction
		// become immediate constants (k). Cleared after the copies; the
		// post-loop store then sets the induction to the trip count (its
		// exact value had the loop run).
		status.induction_const = new Map([[node_condition_name(node), 0]]);
		for (let k = 0; k < unroll_count; k++) {
			status.induction_const.set(node_condition_name(node), k);
			// Allocations (checker-hoisted `_param_N` call-arg temps,
			// interpolation temps, …) are deduped per BUILD via
			// `emitted_allocations`. The same alloc NODE recurs in every
			// copy, so without this snapshot the alloc emits only in copy 0
			// and copy 0's scope-exit cleanup frees the slot later copies
			// still read (observed as Regex.match going empty after the
			// first iteration). Restore per copy → each copy re-emits its
			// own slots.
			const saved_allocs = status.emitted_allocations
				? new Set(status.emitted_allocations)
				: undefined;
			build_block_with_cursor(node, nir!.body, status);
			status.emitted_allocations = saved_allocs;
		}
		status.induction_const = undefined;
		// Post-loop induction value: the dropped loop would have left the
		// counter at the trip count.
		mov_immediate_x0_and_store(status, node_condition_name(node), unroll_count);
	} else {
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
		pushed_labels = true;

		// (String `.length` is a load of the fat string's len half — no
		// strlen hoisting is needed anymore.)

		// NEON vector loop (phase 4): when a plan rides in, emit the 2-lane
		// loop first; the scalar loop below then executes unchanged as the
		// tail. The plan is computed only under an active NIR cursor (see
		// emit_stmt_from_nir), so the AST path — and the byte-identity A/B
		// harness — never sees it.
		if (vector) {
			emit_neon_vector_loop(vector, status);
		}

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

		build_block_with_cursor(node, nir?.body, status);

		if (node.update) {
			status.code += `${continue_label}:\n`;
			build_node(node.update, status);
			if (!status.code.endsWith("\n")) {
				status.code += "\n";
			}
		}

		status.code += `b ${start_label}\n`;
		status.code += `${end_label}:\n`;
	}

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

	if (pushed_labels) status.loop_labels?.pop();
	exit_scope_frame(status, old_scoped_declarations);
}
