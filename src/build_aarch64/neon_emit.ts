import type BuildStatus from "../build_c/BuildStatus.ts";
import { emit_buffer_struct_addr } from "./build_access_node.ts";
import build_node from "./build_node.ts";
import { build_float_operand } from "./build_operation_node.ts";
import type { NeonLaneExpr, NeonLaneStmt, NeonPlan } from "./neon_plan.ts";
import { emit_var_store } from "./utils/stack_var.ts";

/**
 * NEON lowering for planned elementwise float loops (ASM_PLAN phase 4).
 *
 * Given a soundness-checked `NeonPlan`, emits a 2-lane (.2d, 64-bit float)
 * vector loop that runs BEFORE the loop's ordinary scalar emission — the
 * scalar loop then executes unchanged as the tail, covering the remainder
 * the vector loop leaves (N % 2 elements; zero iterations when N is even or
 * the bound is < 2). Per-element results are bit-identical to the scalar
 * loop: the same operations per element in the same order, just two at a
 * time.
 *
 * Shape (L = fresh `.Lneon_N` label):
 *
 *     // preheader
 *     ldr x11, [u_slot+8]        ← one data-pointer load per Buffer
 *     build_node(bound) → x0     ← N (leaf var or literal)
 *     mov x9, x0
 *     asr x9, x9, #1             ← lim = floor(N / 2) vector iterations
 *                                   (2 lanes of f64 each); floor semantics
 *                                   keep every lane index < N for any
 *                                   signed N (negative → loop skipped)
 *     mov x10, #0                ← vector-iteration counter (PAIR units)
 *     L:
 *     cmp x10, x9
 *     b.hs L_end
 *       <lanes: ldr q / dup / fop v.2d / str q at [xK, x10, lsl #4]>
 *     add x10, x10, #1
 *     b L
 *     L_end:
 *     lsl x0, x10, #1            ← i = pairs × 2
 *     emit_var_store(i ← x0)     ← scalar tail continues where the vector
 *                                  loop stopped
 *
 * (Q-register register-offset addressing only encodes scale #0/#4, so the
 * counter runs in 16-byte pair units and the scaled index addresses the
 * lane pair directly — element i is pairs*2.)
 *
 * Register discipline: the vector loop contains NO calls, so the
 * caller-saved scratches x9–x13 and v0–v15 are stable across iterations;
 * the loop never touches callee-saved registers, promoted-variable
 * registers (x19-x28 / d8-d11 pools), or the frame-slot machinery — the
 * only frame access is the standard `emit_var_store` for the induction
 * sync. Per-lane temps live in v4–v7; nested binary operands spill to
 * v14→v11 by depth (max depth 4, enforced by the planner). Everything is
 * reg or reg+scaled-index addressing, so the phase-1 validator and the
 * phase-2 frame-slot optimizer see only shapes already in their contracts.
 *
 * The kill-switch exists for the NIR byte-identity A/B harness: the
 * vectorizer intentionally changes output, so the harness holds it off
 * while proving the emission seam itself is a pure re-encoding.
 */

let neon_vectorization_on = true;
let neon_counter = 0;

export function neon_vectorization_enabled(): boolean {
	return neon_vectorization_on;
}

export function set_neon_vectorization_enabled(enabled: boolean): void {
	neon_vectorization_on = enabled;
}

export function reset_neon_counter(): void {
	neon_counter = 0;
}

/** Buffer data pointers are pinned here (x11..x13); x9 = limit, x10 = index. */
const BUFFER_PTR_REGS = ["x11", "x12", "x13"];
/** Per-lane temp result registers (planner caps at 4 temps). */
const TEMP_REGS = ["v4", "v5", "v6", "v7"];
/** Nested binary spill registers by depth (depth 1 → v14 … depth 4 → v11). */
function spill_reg(depth: number): string {
	return `v${15 - depth}`;
}

function op_mnemonic(op: string): string {
	switch (op) {
		case "+":
			return "fadd";
		case "-":
			return "fsub";
		case "*":
			return "fmul";
		default:
			return "fdiv";
	}
}

function lane_reg_of(name: string, plan: NeonPlan): string {
	// Planner assigns temp registers in def order.
	const temps: string[] = [];
	for (const l of plan.lanes) {
		if (l.kind === "temp_def") {
			if (!temps.includes(l.name)) temps.push(l.name);
		}
	}
	const idx = temps.indexOf(name);
	return TEMP_REGS[idx] ?? "v4";
}

function emit_lane_expr(
	e: NeonLaneExpr,
	status: BuildStatus,
	plan: NeonPlan,
	buffer_regs: Map<string, string>,
	depth: number,
): void {
	switch (e.k) {
		case "load": {
			const reg = buffer_regs.get(e.buffer) ?? "x11";
			status.code += `ldr q0, [${reg}, x10, lsl #4]\n`;
			return;
		}
		case "lit":
		case "scalar": {
			// The scalar float-operand path handles slots, promoted d-regs and
			// bit-pattern param regs; splat the loaded/scalar value across
			// both lanes. d0 is the low half of v0.
			build_float_operand(e.node, "d0", status);
			status.code += `dup v0.2d, v0.d[0]\n`;
			return;
		}
		case "temp": {
			status.code += `mov v0.16b, ${lane_reg_of(e.name, plan)}.16b\n`;
			return;
		}
		case "op": {
			emit_lane_expr(e.left, status, plan, buffer_regs, depth + 1);
			status.code += `mov ${spill_reg(depth)}.16b, v0.16b\n`;
			emit_lane_expr(e.right, status, plan, buffer_regs, depth + 1);
			status.code += `mov v1.16b, v0.16b\n`;
			status.code += `mov v0.16b, ${spill_reg(depth)}.16b\n`;
			status.code += `${op_mnemonic(e.op)} v0.2d, v0.2d, v1.2d\n`;
			return;
		}
	}
	const _exhaustive: never = e;
	void _exhaustive;
}

function emit_lane_stmt(
	lane: NeonLaneStmt,
	status: BuildStatus,
	plan: NeonPlan,
	buffer_regs: Map<string, string>,
): void {
	if (lane.kind === "temp_def") {
		emit_lane_expr(lane.value, status, plan, buffer_regs, 0);
		status.code += `mov ${lane_reg_of(lane.name, plan)}.16b, v0.16b\n`;
		return;
	}
	emit_lane_expr(lane.value, status, plan, buffer_regs, 0);
	const reg = buffer_regs.get(lane.buffer) ?? "x11";
	status.code += `str q0, [${reg}, x10, lsl #4]\n`;
}

/**
 * Emit the vector loop for `plan` into `status.code`. Returns true (the
 * caller then emits the scalar loop as the tail). Assumes the planner
 * returned non-null — every structural condition was verified there.
 */
export function emit_neon_vector_loop(plan: NeonPlan, status: BuildStatus): boolean {
	const saved_d0 = status.float_result_in_d0;
	status.float_result_in_d0 = false;

	if (!status.code.endsWith("\n")) status.code += "\n";

	// Preheader: pin one data pointer per Buffer (emit_buffer_struct_addr
	// targets x9, so these come before the limit lands there).
	const buffer_regs = new Map<string, string>();
	plan.buffers.forEach((b, i) => {
		emit_buffer_struct_addr(b.node, status);
		const reg = BUFFER_PTR_REGS[i] ?? "x11";
		status.code += `ldr ${reg}, [x9, #8]\n`;
		buffer_regs.set(b.name, reg);
	});

	// lim = floor(bound / 2) vector iterations.
	build_node(plan.bound_node, status);
	if (!status.code.endsWith("\n")) status.code += "\n";
	status.code += `mov x9, x0\n`;
	status.code += `asr x9, x9, #1\n`;
	status.code += `mov x10, #0\n`;

	const label = `.Lneon_${neon_counter++}`;
	status.code += `${label}:\n`;
	status.code += `cmp x10, x9\n`;
	status.code += `b.hs ${label}_end\n`;
	for (const lane of plan.lanes) emit_lane_stmt(lane, status, plan, buffer_regs);
	status.code += `add x10, x10, #1\n`;
	status.code += `b ${label}\n`;
	status.code += `${label}_end:\n`;

	// Sync the induction: the scalar tail resumes at the vector loop's exit
	// counter. (int = 8-byte slot / x-register.)
	status.code += `lsl x0, x10, #1\n`;
	emit_var_store(status, "x0", plan.induction, 8);

	status.float_result_in_d0 = saved_d0;
	return true;
}
