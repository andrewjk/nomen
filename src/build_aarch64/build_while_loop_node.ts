import type BuildStatus from "../build_c/BuildStatus.ts";
import type { NirStmt } from "../nir/nir.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import { tryHoistBufferAddrs } from "./buffer_pipeline.ts";
import build_node from "./build_node.ts";
import { emit_cond_branch } from "./build_operation_node.ts";
import { tree_is_call_free } from "./build_operation_node.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import { emit_neon_vector_loop } from "./neon_emit.ts";
import type { NeonPlan } from "./neon_plan.ts";
import type { UnrollPlan } from "./unroll.ts";
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
	unroll?: UnrollPlan | null,
) {
	const old_scoped_declarations = enter_scope_frame(status);

	const promoted: PromotedVar[] = [];
	const saved_reg_allocs = status.register_allocations
		? new Map(status.register_allocations)
		: undefined;
	// Declare-slot pre-allocation (tranche D addendum): promotion records
	// pre-allocated slots for the body's declares; the set lives exactly for
	// this loop's body build (the declare sites consume it) and is restored
	// after so a later declare of the same name can't alias this loop's slot.
	const saved_preallocated = status.preallocated_decl_slots;
	// Field-pair SLP state (ASM_PLAN_4): promotion stashes this loop's
	// planned lane pairs + reserved v-registers; visible to the body
	// (including nested loops) and restored at exit, like the register
	// claims.
	const saved_slp_hints = status.slp_pair_hints;
	const saved_slp_vregs = status.slp_pair_vregs;
	const saved_buffer_cache = status.buffer_data_cache;
	status.buffer_data_cache = undefined;
	// Fixed-array pointer cache (ASM_PLAN_3 tranche A): the induction may
	// advance between iterations, so no pinned element address may cross a
	// loop boundary in either direction.
	const saved_array_cache = status.array_ptr_cache;
	status.array_ptr_cache = undefined;
	const saved_base_cache = (
		status as unknown as {
			buffer_base_cache?: Map<string, { baseReg: string; induction: string; dataReg?: string }>;
		}
	).buffer_base_cache;
	(
		status as unknown as {
			buffer_base_cache?: Map<string, { baseReg: string; induction: string; dataReg?: string }>;
		}
	).buffer_base_cache = undefined;

	if (status.function_return_label && node.statements.length > 0) {
		// Caller-saved float extension pool is safe when the loop body is
		// call-free (nothing clobbers v24-v31 mid-loop). NIR body when
		// available; AST-declared vars fall back to the callee-only pool.
		// tree_is_call_free (tranche F) extends the scan to inline methods
		// whose raw aarch64 bodies contain no bl/blr, and gates the int
		// extension pool off when a NEON plan rides (the vector loop's
		// preheader/lanes clobber x12-x15). Both arms (AST walk and NIR
		// cursor) must reach the SAME verdict — promotion decisions drive
		// prologue saves and register traffic — so the AST arm scans the
		// AST statements when no NIR body rides.
		const call_free = nir
			? nir.body.every((st) => tree_is_call_free(st.node, status, new Set()))
			: node.statements.every((st) => tree_is_call_free(st, status, new Set()));
		promoted.push(
			...promote_loop_locals(
				status,
				old_scoped_declarations,
				{
					condition: node.condition,
					statements: node.statements,
					update: node.update,
				},
				{ call_free, int_ext: call_free && !vector },
			),
		);
		// Field-pair SLP (ASM_PLAN_4): a pair hosting v8 (the NEON
		// accumulator) makes the vector plan unsafe for this loop — drop
		// it and emit the scalar loop.
		if (vector && status.slp_pair_vregs?.has("v8")) {
			vector = null;
		}
	}

	let pushed_labels = false;
	if (unroll) {
		// Full unrolling (ASM_PLAN_2 tranche A): the plan guarantees the trip
		// count is exact (literal `<` bound, constant init, +1 step), the
		// body never assigns the induction, and no break/continue targets
		// this loop — so the body is emitted once per trip and the loop
		// machinery (counter, compare, branch, labels) disappears. Each copy
		// rides the NIR cursor; promotion above keeps body floats in
		// registers across copies. Computed only under an active NIR cursor
		// (see emit_stmt_from_nir), so the AST/byte-identity path never sees
		// it.
		// Index-substitution mode (tranche E): the body READS the
		// induction as an index — per copy, reads of the induction become
		// immediate constants (init + k).
		// Outer-first composition (tranche E addendum): the plan's init is
		// constant under the AMBIENT map (an enclosing copy holds its own
		// induction constant — `j = i + 1`), so the ambient entries are
		// preserved while this loop's constant rides on top, and restored
		// afterwards. A nested loop unrolling inside a copy re-enters this
		// branch and stacks its constant the same way; the post-loop store
		// leaves the induction at its exact had-run value (init + trip).
		const induction = node_condition_name(node);
		const saved_induction_const = status.induction_const;
		status.induction_const = new Map(saved_induction_const ?? []);
		for (let k = 0; k < unroll.trip; k++) {
			status.induction_const.set(induction, unroll.init + k);
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
			// Fixed-array pointer cache (ASM_PLAN_3 tranche C): cache keys
			// ride the induction's NAME (`bodies@j`), and in index-constant
			// mode the update that would invalidate them is DELETED — so a
			// pin from copy k would survive into copy k+1 with copy k's
			// address. Give each copy a fresh map (seeded with the enclosing
			// scope's pins — an outer copy's `bodies@i` stays valid: its
			// constant is fixed for this whole copy) and release the
			// register claims this copy added: the pins die with the copy,
			// so the next copy re-fills into the SAME registers instead of
			// exhausting the pool into generic fallbacks.
			const saved_array_cache: Map<string, string> | undefined = status.array_ptr_cache;
			const saved_claims = status.callee_saved_regs_used
				? new Set(status.callee_saved_regs_used)
				: undefined;
			status.array_ptr_cache = saved_array_cache ? new Map(saved_array_cache) : undefined;
			build_block_with_cursor(node, nir!.body, status);
			status.array_ptr_cache = saved_array_cache;
			if (status.callee_saved_regs_used && saved_claims) {
				for (const r of Array.from(status.callee_saved_regs_used)) {
					if (!saved_claims.has(r)) status.callee_saved_regs_used.delete(r);
				}
			}
			status.emitted_allocations = saved_allocs;
		}
		status.induction_const = saved_induction_const;
		mov_immediate_x0_and_store(status, induction, unroll.init + unroll.trip);
	} else {
		// Inline Buffer address pipeline (tranche K): hoist data pointers and
		// invariant index bases for remainder.digits et al. so inner Knuth-D
		// loops pay one `add x1, base, ind` per access instead of the full
		// recomputation. Runs in the preheader (before the loop label) so the
		// hoisted values are live on entry.
		if (nir) tryHoistBufferAddrs(node, nir.body, status);
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
	status.preallocated_decl_slots = saved_preallocated;
	status.slp_pair_hints = saved_slp_hints;
	status.slp_pair_vregs = saved_slp_vregs;

	status.buffer_data_cache = saved_buffer_cache;
	status.array_ptr_cache = saved_array_cache;
	(
		status as unknown as {
			buffer_base_cache?: Map<string, { baseReg: string; induction: string; dataReg?: string }>;
		}
	).buffer_base_cache = saved_base_cache;

	if (pushed_labels) status.loop_labels?.pop();
	exit_scope_frame(status, old_scoped_declarations);
}
