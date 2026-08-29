import type BuildStatus from "../build_c/BuildStatus.ts";
import { emit_buffer_struct_addr } from "./build_access_node.ts";
import build_node from "./build_node.ts";
import { build_float_operand } from "./build_operation_node.ts";
import type { ElemDesc, NeonLaneExpr, NeonLaneStmt, NeonPlan } from "./neon_plan.ts";
import { emit_var_store } from "./utils/stack_var.ts";

/**
 * NEON lowering for planned elementwise Buffer loops (ASM_PLAN phase 4).
 *
 * Given a soundness-checked `NeonPlan`, emits a vector loop that runs
 * BEFORE the loop's ordinary scalar emission — the scalar loop then
 * executes unchanged as the tail, covering the remainder the vector loop
 * leaves. Per-element results are bit-identical to the scalar loop: the
 * same operations per element in the same order, just a group at a time.
 *
 * Element kinds (descriptor from the Buffer method pair): f64 via
 * load_float/store_float (`.2d`), 8-byte int via load_int/store_int
 * (`.2d`, wrap-exact + - * and lane-wise & | ^), 4-byte int via load/store
 * (`.4s`).
 *
 * Shape (L = fresh `.Lneon_N` label, G = group elements = 2 or 4):
 *
 *     // preheader
 *     ldr x11, [u_slot+8]        ← one data-pointer load per Buffer
 *     build_node(bound) → x0     ← N (leaf var or literal)
 *     mov x9, x0
 *     asr x9, x9, #log2(G)       ← lim = floor(N / G) groups
 *     bic x9, x9, #1             ← rounded to whole unrolled double-groups
 *     mov x10, #0                ← counter (GROUP units)
 *     L:
 *     cmp x10, x9
 *     b.hs L_end
 *       <lanes at [xK, x10, lsl #4]>     ← first group
 *     add x14, x10, #1
 *       <lanes at [xK, x14, lsl #4]>     ← second group (unroll-by-2)
 *     add x10, x10, #2
 *     b L
 *     L_end:
 *     lsl x0, x10, #log2(G)      ← i = groups × G
 *     emit_var_store(i ← x0)     ← scalar tail continues where the vector
 *                                  loop stopped
 *
 * (Q-register register-offset addressing only encodes scale #0/#4, so the
 * counter runs in 16-byte group units and the scaled index addresses the
 * group directly — element i is groups*G.)
 *
 * Register discipline: the vector loop contains NO calls, so the
 * caller-saved scratches x9–x15 and v0–v15 are stable across iterations;
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

/** Buffer data pointers are pinned here (x11..x13); x9 = limit, x10 = index,
 *  x14 = second unrolled group index. */
const BUFFER_PTR_REGS = ["x11", "x12", "x13"];
/** Vector accumulator registers (planner caps at 2 reductions). */
const REDUCTION_REGS = ["v2", "v3"];
/** Per-lane temp result registers (planner caps at 4 temps). */
const TEMP_REGS = ["v4", "v5", "v6", "v7"];
/** Nested binary spill registers by depth (depth 1 → v14 … depth 4 → v11). */
function spill_reg(depth: number): string {
	return `v${15 - depth}`;
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
	idx: string,
	depth: number,
): void {
	switch (e.k) {
		case "load": {
			const reg = buffer_regs.get(e.buffer) ?? "x11";
			status.code += `ldr q0, [${reg}, ${idx}, lsl #4]\n`;
			return;
		}
		case "lit":
		case "scalar": {
			// Materialize the scalar value, then splat it across the group's
			// lanes. Floats ride the scalar float-operand path (slots,
			// promoted d-regs, bit-pattern param regs) into d0 = low half of
			// v0; ints ride the ordinary value path into x0.
			if (plan.elem.float) {
				build_float_operand(e.node, "d0", status);
				status.code += `dup v0.2d, v0.d[0]\n`;
			} else {
				build_node(e.node, status);
				if (!status.code.endsWith("\n")) status.code += "\n";
				status.code += `dup v0.${plan.elem.arr}, ${plan.elem.arr === "4s" ? "w0" : "x0"}\n`;
			}
			return;
		}
		case "temp": {
			status.code += `mov v0.16b, ${lane_reg_of(e.name, plan)}.16b\n`;
			return;
		}
		case "op": {
			emit_lane_expr(e.left, status, plan, buffer_regs, idx, depth + 1);
			status.code += `mov ${spill_reg(depth)}.16b, v0.16b\n`;
			emit_lane_expr(e.right, status, plan, buffer_regs, idx, depth + 1);
			status.code += `mov v1.16b, v0.16b\n`;
			status.code += `mov v0.16b, ${spill_reg(depth)}.16b\n`;
			const { mnemonic, arr } = lane_op(e.op, plan.elem);
			status.code += `${mnemonic} v0.${arr}, v0.${arr}, v1.${arr}\n`;
			return;
		}
	}
	const _exhaustive: never = e;
	void _exhaustive;
}

function lane_op(op: string, elem: ElemDesc): { mnemonic: string; arr: "2d" | "4s" | "16b" } {
	if (elem.float) {
		switch (op) {
			case "+":
				return { mnemonic: "fadd", arr: elem.arr };
			case "-":
				return { mnemonic: "fsub", arr: elem.arr };
			case "*":
				return { mnemonic: "fmul", arr: elem.arr };
			default:
				return { mnemonic: "fdiv", arr: elem.arr };
		}
	}
	switch (op) {
		case "+":
			return { mnemonic: "add", arr: elem.arr };
		case "-":
			return { mnemonic: "sub", arr: elem.arr };
		case "*":
			return { mnemonic: "mul", arr: elem.arr };
		case "&":
			return { mnemonic: "and", arr: "16b" };
		case "|":
			return { mnemonic: "orr", arr: "16b" };
		default:
			return { mnemonic: "eor", arr: "16b" };
	}
}

function emit_lane_stmt(
	lane: NeonLaneStmt,
	status: BuildStatus,
	plan: NeonPlan,
	buffer_regs: Map<string, string>,
	idx: string,
	acc_regs: Map<string, string>,
): void {
	if (lane.kind === "temp_def") {
		emit_lane_expr(lane.value, status, plan, buffer_regs, idx, 0);
		status.code += `mov ${lane_reg_of(lane.name, plan)}.16b, v0.16b\n`;
		return;
	}
	if (lane.kind === "reduction") {
		// Vector-accumulate: vACC +=/*= operand (the accumulator never
		// enters lane_expr — its self-read is the carried dependency).
		emit_lane_expr(lane.operand, status, plan, buffer_regs, idx, 0);
		const acc = acc_regs.get(lane.name) ?? "v2";
		const mn = lane.op === "+" ? "fadd" : "fmul";
		status.code += `${mn} ${acc}.2d, ${acc}.2d, v0.2d\n`;
		return;
	}
	emit_lane_expr(lane.value, status, plan, buffer_regs, idx, 0);
	const reg = buffer_regs.get(lane.buffer) ?? "x11";
	status.code += `str q0, [${reg}, ${idx}, lsl #4]\n`;
}

/**
 * Emit the vector loop for `plan` into `status.code`. Returns true (the
 * caller then emits the scalar loop as the tail). Assumes the planner
 * returned non-null — every structural condition was verified there.
 *
 * Unroll-by-2: each iteration processes TWO 16-byte groups (4 f64/i64
 * elements, or 8 u32 elements) — the second group rides x14 = x10 + 1, and
 * the counter steps 2 in group units. The limit is floor(N / group_elems)
 * rounded down to a multiple of 2 (`asr` then `bic #1`), so only complete
 * double-groups vectorize; the scalar tail mops up the rest.
 *
 * Reductions (fast_math opt-in): each accumulator splats its loop-entry
 * value into v2/v3 before the loop, accumulates both unrolled groups per
 * iteration, and is horizontally combined into its scalar at the end —
 * the scalar tail then continues from the combined value. Reassociation:
 * the pair-wise accumulation order differs from the sequential scalar
 * loop (last-ulp differences are the documented fast_math contract).
 */
export function emit_neon_vector_loop(plan: NeonPlan, status: BuildStatus): boolean {
	const saved_d0 = status.float_result_in_d0;
	status.float_result_in_d0 = false;
	const shift = plan.elem.shift;

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

	// Preheader: splat each accumulator's loop-entry value into v2/v3.
	const acc_regs = new Map<string, string>();
	plan.reductions.forEach((r, i) => {
		const reg = REDUCTION_REGS[i] ?? "v2";
		build_float_operand(r.init_node, "d0", status);
		status.code += `dup ${reg}.2d, v0.d[0]\n`;
		acc_regs.set(r.name, reg);
	});

	// lim = floor(bound / group_elems) double-groups.
	build_node(plan.bound_node, status);
	if (!status.code.endsWith("\n")) status.code += "\n";
	status.code += `mov x9, x0\n`;
	status.code += `asr x9, x9, #${shift}\n`;
	status.code += `bic x9, x9, #1\n`;
	status.code += `mov x10, #0\n`;

	const label = `.Lneon_${neon_counter++}`;
	status.code += `${label}:\n`;
	status.code += `cmp x10, x9\n`;
	status.code += `b.hs ${label}_end\n`;
	for (const lane of plan.lanes) emit_lane_stmt(lane, status, plan, buffer_regs, "x10", acc_regs);
	status.code += `add x14, x10, #1\n`;
	for (const lane of plan.lanes) emit_lane_stmt(lane, status, plan, buffer_regs, "x14", acc_regs);
	status.code += `add x10, x10, #2\n`;
	status.code += `b ${label}\n`;
	status.code += `${label}_end:\n`;

	// Horizontal-combine each accumulator into its scalar (d0 = lane0 ∘
	// lane1), then store — the scalar tail continues from the combined
	// value. emit_var_store resolves slots and promoted d-registers; the
	// planner rejects param accumulators.
	for (const r of plan.reductions) {
		const reg = acc_regs.get(r.name) ?? "v2";
		if (r.op === "+") {
			status.code += `faddp d0, ${reg}.2d\n`;
		} else {
			status.code += `fmul d0, ${reg}.d[0], ${reg}.d[1]\n`;
		}
		emit_var_store(status, "d0", r.name, 8);
	}

	// Sync the induction: the scalar tail resumes at the vector loop's exit
	// counter (group units → element index). (int = 8-byte slot / x-reg.)
	status.code += `lsl x0, x10, #${shift}\n`;
	emit_var_store(status, "x0", plan.induction, 8);

	status.float_result_in_d0 = saved_d0;
	return true;
}
