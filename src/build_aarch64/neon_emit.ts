import type BuildStatus from "../build_c/BuildStatus.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import { emit_buffer_struct_addr } from "./build_access_node.ts";
import build_node from "./build_node.ts";
import { build_float_operand } from "./build_operation_node.ts";
import type { ElemDesc, NeonLaneExpr, NeonLaneStmt, NeonPlan } from "./neon_plan.ts";
import { emit_asm, ensure_newline } from "./utils/code_buffer.ts";
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
 * Straight-line lane-group peel (plan.peel > 0): before the counted loop,
 * the plan runs ONCE over `peel` whole groups with ZERO loop machinery —
 * the fixed-trip lane-compute shape (4 × `.2d` = the references' 8-lane
 * f64 vectors). A value-level allocation gives every lane temp one cell
 * register per group (v0–v7), ops read cells/splats directly (no staging
 * movs), and loads/stores address the group by immediate offset
 * (`ldr q0, [x11, #16]`). A runtime bound guards the block with one
 * compare+branch (`bound < peel*G + max_shift` skips it, x10 starts at 0
 * instead of `peel`); the counted loop resumes at group `peel` either way,
 * so big-N loops keep full vector coverage and no element is computed
 * twice. The scalar tail is unchanged.
 *
 * Register discipline: the vector loop contains NO calls, so the
 * caller-saved scratches x9–x17 and v0–v15 are stable across iterations;
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

/** Buffer data pointers are pinned here (x11..x13, x15); x9 = limit,
 *  x10 = index, x14 = second unrolled group index. */
const BUFFER_PTR_REGS = ["x11", "x12", "x13", "x15"];
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

/** Low-half d-register of a v-register (dN aliases vN.d[0]). */
function d_of(vreg: string): string {
	return `d${vreg.slice(1)}`;
}

// --- Straight-line lane-group peel ------------------------------------------
//
// The peel runs the plan once over `peel` whole groups before the counted
// loop, straight-line. Register file:
//
// - v0–v7: value CELLS — lane temp t (def order) × group g lives in
//   v{t*4+g}. The counted loop's own temp regs (v4–v7) are dead by the
//   time it resumes at group `peel`, so the peel may claim the whole bank.
// - v15→v11: operand slots, indexed by lane-op depth (depth d writes the
//   subtree's slot v{15-d}); the planner caps peel depth at 3 so slots
//   never reach the splat regs below.
// - v9/v10: shared preheader splats (scalars, and literals on peel plans).
// - v8: untouched (the counted loop's FMA park).
//
// The evaluator RETURNS the register holding the value, so leaf operands
// (loads materialize into their slot, temps/splats are their own cells)
// reach an op with no staging mov, and a store whose value is already a
// cell or splat stores straight from it.

/** Cell registers of lane temp `name` for the peel: one per group. Temps
 *  the plan inlines into their single consumer get no cells. */
function peel_cells(plan: NeonPlan): Map<string, string[]> {
	const cells = new Map<string, string[]>();
	let t = 0;
	for (const l of plan.lanes) {
		if (l.kind !== "temp_def" || cells.has(l.name)) continue;
		if (plan.peel_inline.includes(l.name)) continue;
		cells.set(
			l.name,
			Array.from({ length: plan.peel }, (_, g) => `v${t * 4 + g}`),
		);
		t++;
	}
	return cells;
}

/** Operand slot for lane-op depth `depth` (0 → v15 … 4 → v11). */
function peel_slot(depth: number): string {
	return `v${15 - depth}`;
}

/**
 * Per-plan preheader splats of loop-invariant scalar operands. plan_common
 * classifies every local/param never defined in the loop as a "scalar" leaf,
 * so each distinct one materializes ONCE into a dedicated v register (v9,
 * v10) and references inside the loop become a single mov — instead of
 * rebuilding the scalar (slot load / promoted d-reg / bit-pattern param
 * move) plus a dup per reference per group.
 */
const SCALAR_SPLAT_REGS = ["v9", "v10"];

function scalar_splat_reg(
	e: Extract<NeonLaneExpr, { k: "scalar" }>,
	splats: Map<string, string>,
): string | null {
	const held = splats.get(e.name);
	if (held) return held;
	if (splats.size >= SCALAR_SPLAT_REGS.length) return null;
	const reg = SCALAR_SPLAT_REGS[splats.size];
	splats.set(e.name, reg);
	return reg;
}

function emit_lane_expr(
	e: NeonLaneExpr,
	status: BuildStatus,
	plan: NeonPlan,
	buffer_regs: Map<string, string>,
	shifted_regs: Map<string, string>,
	idx: string,
	depth: number,
	target: string,
	splats: Map<string, string>,
): void {
	switch (e.k) {
		case "load": {
			const key = `${e.buffer} ${e.shift}`;
			const shifted = shifted_regs.get(key);
			if (shifted) {
				emit_asm(status, `ldr q${target.slice(1)}, [${shifted}, ${idx}, lsl #4]\n`);
			} else {
				const reg = buffer_regs.get(e.buffer) ?? "x11";
				emit_asm(status, `ldr q${target.slice(1)}, [${reg}, ${idx}, lsl #4]\n`);
			}
			return;
		}
		case "lit":
		case "scalar": {
			// Loop-invariant scalars ride their preheader splat: one mov per
			// reference instead of rebuild + dup. (Literals stay per-reference
			// — fmov is as cheap as the mov and hoisting every distinct
			// constant would exhaust the two splat registers.)
			if (e.k === "scalar") {
				const splat = scalar_splat_reg(e, splats);
				if (splat) {
					emit_asm(status, `mov ${target}.16b, ${splat}.16b\n`);
					return;
				}
			}
			// Materialize the scalar value, then splat it across the group's
			// lanes. Floats ride the scalar float-operand path (slots,
			// promoted d-regs, bit-pattern param regs) into the target's
			// low half; ints ride the ordinary value path into x0.
			if (plan.elem.float) {
				build_float_operand(e.node, d_of(target), status);
				emit_asm(status, `dup ${target}.2d, ${target}.d[0]\n`);
			} else {
				build_node(e.node, status);
				ensure_newline(status);
				emit_asm(
					status,
					`dup ${target}.${plan.elem.arr}, ${plan.elem.arr === "2d" ? "x0" : "w0"}\n`,
				);
			}
			return;
		}
		case "temp": {
			emit_asm(status, `mov ${target}.16b, ${lane_reg_of(e.name, plan)}.16b\n`);
			return;
		}
		case "op": {
			// FMA contraction (fast_math): fuse `c ± n*m` into fmla/fmls.
			// fmla vd, vn, vm → vd += vn*vm; fmls → vd -= vn*vm — so `+`
			// contracts with the mul on either side, `-` only with the mul
			// on the right (left-mul `-` = n*m - c has no accumulate form).
			// c parks in v8 — dedicated (v2/v3 reductions, v4–v7 temps,
			// v11–v14 op spills), so reduction operands stay conflict-free.
			if (plan.fma_contract && plan.elem.float && (e.op === "+" || e.op === "-")) {
				type OpExpr = Extract<NeonLaneExpr, { k: "op" }>;
				const mul_of = (x: NeonLaneExpr): OpExpr | null =>
					x.k === "op" && x.op === "*" ? x : null;
				const left_mul = mul_of(e.left);
				const right_mul = left_mul ? null : mul_of(e.right);
				const mul = left_mul ?? right_mul;
				if (mul && (e.op === "+" || !left_mul)) {
					emit_lane_expr(
						left_mul ? e.right : e.left,
						status,
						plan,
						buffer_regs,
						shifted_regs,
						idx,
						depth + 1,
						"v0",
						splats,
					);
					emit_asm(status, `mov v8.16b, v0.16b\n`);
					emit_lane_expr(
						mul.left,
						status,
						plan,
						buffer_regs,
						shifted_regs,
						idx,
						depth + 1,
						"v0",
						splats,
					);
					emit_asm(status, `mov ${spill_reg(depth + 1)}.16b, v0.16b\n`);
					emit_lane_expr(
						mul.right,
						status,
						plan,
						buffer_regs,
						shifted_regs,
						idx,
						depth + 1,
						"v0",
						splats,
					);
					emit_asm(status, `mov v1.16b, v0.16b\n`);
					emit_asm(status, `mov v0.16b, ${spill_reg(depth + 1)}.16b\n`);
					emit_asm(status, `${e.op === "+" ? "fmla" : "fmls"} v8.2d, v0.2d, v1.2d\n`);
					emit_asm(status, `mov ${target}.16b, v8.16b\n`);
					return;
				}
			}
			// Leaf operands load/materialize directly into their operand
			// register, so a leaf side costs no staging mov. When the RIGHT
			// side is a leaf, evaluate the (possibly compound) left into v0,
			// the leaf straight into v1, and operate — no spill/restore. The
			// compound-left recursion may itself use v1, but it has finished
			// by the time the leaf lands there. Every other shape keeps the
			// classic dance: left → spill, right → v1, restore, operate.
			const right_is_leaf = e.right.k !== "op";
			if (right_is_leaf) {
				emit_lane_expr(
					e.left,
					status,
					plan,
					buffer_regs,
					shifted_regs,
					idx,
					depth + 1,
					"v0",
					splats,
				);
				emit_lane_expr(e.right, status, plan, buffer_regs, shifted_regs, idx, depth, "v1", splats);
			} else {
				emit_lane_expr(
					e.left,
					status,
					plan,
					buffer_regs,
					shifted_regs,
					idx,
					depth + 1,
					"v0",
					splats,
				);
				emit_asm(status, `mov ${spill_reg(depth)}.16b, v0.16b\n`);
				emit_lane_expr(
					e.right,
					status,
					plan,
					buffer_regs,
					shifted_regs,
					idx,
					depth + 1,
					"v0",
					splats,
				);
				emit_asm(status, `mov v1.16b, v0.16b\n`);
				emit_asm(status, `mov v0.16b, ${spill_reg(depth)}.16b\n`);
			}
			const { mnemonic, arr } = lane_op(e.op, plan.elem);
			emit_asm(status, `${mnemonic} v0.${arr}, v0.${arr}, v1.${arr}\n`);
			if (target !== "v0") emit_asm(status, `mov ${target}.16b, v0.16b\n`);
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

/**
 * Peel expression evaluation (straight-line lane-group shape). Returns the
 * register holding the group-`group` value of `e`, writing it to `target`
 * only when materialization is needed — temps are their own cell registers,
 * pooled scalars/literals are returned as-is, and loads land in the target
 * slot, so an op's operands usually need no staging mov at all.
 *
 * `cse` is the caller-op's load cache: an op creates one map shared by its
 * two children, so `(zr.load + zr.load)` issues one load. Nested ops make
 * their own (a sibling's slots may be overwritten; cross-subtree reuse
 * would be stale).
 */
function emit_peel_expr(
	e: NeonLaneExpr,
	status: BuildStatus,
	plan: NeonPlan,
	buffer_regs: Map<string, string>,
	shifted_regs: Map<string, string>,
	group: number,
	target: string,
	depth: number,
	splats: Map<string, string>,
	cells: Map<string, string[]>,
	defs: Map<string, NeonLaneExpr>,
	cse: Map<string, string>,
): string {
	switch (e.k) {
		case "load": {
			const key = `${e.buffer} ${e.shift} ${group}`;
			const hit = cse.get(key);
			if (hit) return hit;
			// Resident kernel: a carried buffer's group value lives in its
			// v-register (loaded once in the enclosing loop's preheader) —
			// the load is a register read.
			if (plan.resident && e.shift === 0) {
				const carried = plan.resident.find((r) => r.buffer === e.buffer);
				if (carried) {
					cse.set(key, carried.vregs[group]);
					return carried.vregs[group];
				}
			}
			const base = shifted_regs.get(`${e.buffer} ${e.shift}`) ?? buffer_regs.get(e.buffer) ?? "x11";
			emit_asm(status, `ldr q${target.slice(1)}, [${base}, #${group * 16}]\n`);
			cse.set(key, target);
			return target;
		}
		case "lit":
		case "scalar": {
			const key = e.k === "scalar" ? e.name : `#${(e.node as ValueNode).value}`;
			const splat = splats.get(key);
			if (splat) return splat;
			// Unpooled fallback: materialize into the target slot per group.
			if (plan.elem.float) {
				build_float_operand(e.node, d_of(target), status);
				emit_asm(status, `dup ${target}.2d, ${target}.d[0]\n`);
			} else {
				build_node(e.node, status);
				ensure_newline(status);
				emit_asm(
					status,
					`dup ${target}.${plan.elem.arr}, ${plan.elem.arr === "2d" ? "x0" : "w0"}\n`,
				);
			}
			return target;
		}
		case "temp": {
			// An inlined single-consumer temp evaluates its def's tree right
			// here (fresh CSE cache — the substituted subtree owns its own
			// loads; all loads within one statement see pre-store state, so
			// sharing the caller's cache would still be value-correct, but a
			// fresh one keeps each op's cache self-contained).
			if (plan.peel_inline.includes(e.name)) {
				const def = defs.get(e.name)!;
				return emit_peel_expr(
					def,
					status,
					plan,
					buffer_regs,
					shifted_regs,
					group,
					target,
					depth,
					splats,
					cells,
					defs,
					new Map(),
				);
			}
			return cells.get(e.name)?.[group] ?? "v0";
		}
		case "op": {
			const cache = new Map<string, string>();
			const r_l = emit_peel_expr(
				e.left,
				status,
				plan,
				buffer_regs,
				shifted_regs,
				group,
				peel_slot(depth),
				depth + 1,
				splats,
				cells,
				defs,
				cache,
			);
			const r_r = emit_peel_expr(
				e.right,
				status,
				plan,
				buffer_regs,
				shifted_regs,
				group,
				peel_slot(depth + 1),
				depth + 1,
				splats,
				cells,
				defs,
				cache,
			);
			const { mnemonic, arr } = lane_op(e.op, plan.elem);
			emit_asm(status, `${mnemonic} ${target}.${arr}, ${r_l}.${arr}, ${r_r}.${arr}\n`);
			return target;
		}
	}
	const _exhaustive: never = e;
	void _exhaustive;
	return target;
}

/** The straight-line peel body: every lane statement, per group, in
 *  statement-major × group-minor order — all loads (statement order is
 *  store-free ahead of them, verified by the planner) run ahead of every
 *  store, matching the scalar event order. Zero branches. */
function emit_neon_peel(
	plan: NeonPlan,
	status: BuildStatus,
	buffer_regs: Map<string, string>,
	shifted_regs: Map<string, string>,
	splats: Map<string, string>,
): void {
	const cells = peel_cells(plan);
	const defs = new Map<string, NeonLaneExpr>();
	for (const lane of plan.lanes) {
		if (lane.kind === "temp_def") defs.set(lane.name, lane.value);
	}
	for (const lane of plan.lanes) {
		if (lane.kind === "reduction") continue; // peel plans carry none
		if (lane.kind === "temp_def") {
			if (plan.peel_inline.includes(lane.name)) continue; // fused into its consumer
			const regs = cells.get(lane.name)!;
			for (let g = 0; g < plan.peel; g++) {
				const r = emit_peel_expr(
					lane.value,
					status,
					plan,
					buffer_regs,
					shifted_regs,
					g,
					regs[g],
					0,
					splats,
					cells,
					defs,
					new Map(),
				);
				if (r !== regs[g]) emit_asm(status, `mov ${regs[g]}.16b, ${r}.16b\n`);
			}
			continue;
		}
		const reg = buffer_regs.get(lane.buffer) ?? "x11";
		for (let g = 0; g < plan.peel; g++) {
			const r = emit_peel_expr(
				lane.value,
				status,
				plan,
				buffer_regs,
				shifted_regs,
				g,
				peel_slot(0),
				0,
				splats,
				cells,
				defs,
				new Map(),
			);
			// Resident kernel: the store moves the computed group value into
			// the carried buffer's v-register (memory resyncs at the
			// enclosing loop's boundary).
			const carried = plan.resident?.find((c) => c.buffer === lane.buffer);
			if (carried) {
				emit_asm(status, `mov ${carried.vregs[g]}.16b, ${r}.16b\n`);
				continue;
			}
			emit_asm(status, `str q${r.slice(1)}, [${reg}, #${g * 16}]\n`);
		}
	}
}

function emit_lane_stmt(
	lane: NeonLaneStmt,
	status: BuildStatus,
	plan: NeonPlan,
	buffer_regs: Map<string, string>,
	shifted_regs: Map<string, string>,
	idx: string,
	acc_regs: Map<string, string>,
	splats: Map<string, string>,
): void {
	if (lane.kind === "temp_def") {
		emit_lane_expr(lane.value, status, plan, buffer_regs, shifted_regs, idx, 0, "v0", splats);
		emit_asm(status, `mov ${lane_reg_of(lane.name, plan)}.16b, v0.16b\n`);
		return;
	}
	if (lane.kind === "reduction") {
		// Vector-accumulate: vACC ∘= operand (the accumulator never enters
		// lane_expr — its self-read is the carried dependency). Floats use
		// fadd/fmul; integer `+` rides `add` (wrap-exact).
		emit_lane_expr(lane.operand, status, plan, buffer_regs, shifted_regs, idx, 0, "v0", splats);
		const acc = acc_regs.get(lane.name) ?? "v2";
		// Min/max ride FMINNM/FMAXNM (minNum semantics: NaN operands are
		// suppressed exactly like the scalar `<`/`>` compare skips them);
		// the ±0-sign difference is unobservable under the planner's
		// comparison-only-use gate.
		const mn =
			lane.op === "min"
				? "fminnm"
				: lane.op === "max"
					? "fmaxnm"
					: lane.op === "+"
						? plan.elem.float
							? "fadd"
							: "add"
						: "fmul";
		emit_asm(
			status,
			`${mn} ${acc}.${plan.elem.arr}, ${acc}.${plan.elem.arr}, v0.${plan.elem.arr}\n`,
		);
		return;
	}
	emit_lane_expr(lane.value, status, plan, buffer_regs, shifted_regs, idx, 0, "v0", splats);
	const reg = buffer_regs.get(lane.buffer) ?? "x11";
	emit_asm(status, `str q0, [${reg}, ${idx}, lsl #4]\n`);
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

	ensure_newline(status);

	// Preheader: pin one data pointer per Buffer (emit_buffer_struct_addr
	// targets x9, so these come before the limit lands there).
	const buffer_regs = new Map<string, string>();
	plan.buffers.forEach((b, i) => {
		emit_buffer_struct_addr(b.node, status);
		const reg = BUFFER_PTR_REGS[i] ?? "x11";
		emit_asm(status, `ldr ${reg}, [x9, #8]\n`);
		buffer_regs.set(b.name, reg);
	});

	// Preheader: materialize one ADJUSTED data pointer per distinct
	// (buffer, shift > 0) read group — `buf + shift * elem_size` — so a
	// shifted load reuses the group-indexed `[reg, idx, lsl #4]` form with
	// zero per-iteration cost. x16–x17 are caller-saved scratch (x15 can be
	// a 4th buffer pointer); the loop bodies are call-free by construction
	// (plan_common refuses calls).
	const SHIFT_PTR_REGS = ["x16", "x17"];
	const shifted_regs = new Map<string, string>();
	{
		const elem_size = 16 / plan.elem.group_elems;
		let spi = 0;
		const seen = new Set<string>();
		const visit = (e: NeonLaneExpr | undefined): void => {
			if (!e) return;
			if (e.k === "load" && e.shift > 0) {
				const key = `${e.buffer} ${e.shift}`;
				if (!seen.has(key)) {
					seen.add(key);
					if (spi >= SHIFT_PTR_REGS.length) return;
					const base = buffer_regs.get(e.buffer) ?? "x11";
					const reg = SHIFT_PTR_REGS[spi++];
					emit_asm(status, `add ${reg}, ${base}, #${e.shift * elem_size}\n`);
					shifted_regs.set(key, reg);
				}
			} else if (e.k === "op") {
				visit(e.left);
				visit(e.right);
			}
		};
		for (const lane of plan.lanes) {
			if (lane.kind === "store") visit(lane.value);
			else if (lane.kind === "temp_def") visit(lane.value);
			else if (lane.kind === "reduction") visit(lane.operand);
		}
	}

	// Preheader: splat each accumulator's loop-entry value into v2/v3.
	const acc_regs = new Map<string, string>();
	plan.reductions.forEach((r, i) => {
		const reg = REDUCTION_REGS[i] ?? "v2";
		if (plan.elem.float) {
			build_float_operand(r.init_node, "d0", status);
			emit_asm(status, `dup ${reg}.2d, v0.d[0]\n`);
		} else {
			build_node(r.init_node, status);
			ensure_newline(status);
			emit_asm(status, `dup ${reg}.${plan.elem.arr}, ${plan.elem.arr === "2d" ? "x0" : "w0"}\n`);
		}
		acc_regs.set(r.name, reg);
	});

	// Preheader: materialize each distinct loop-invariant scalar operand
	// once (v9, v10) so in-loop references are a single mov. Collected in
	// first-use order; overflow falls back to per-reference materialization.
	// Peel plans pool their literals beside the scalars — a peel references
	// each literal once per group, so the splat pays for itself immediately.
	const splats = new Map<string, string>();
	{
		const scalars: Extract<NeonLaneExpr, { k: "scalar" }>[] = [];
		const lits: Extract<NeonLaneExpr, { k: "lit" }>[] = [];
		const visit = (e: NeonLaneExpr | undefined): void => {
			if (!e) return;
			if (e.k === "scalar") {
				if (!scalars.some((s) => s.name === e.name)) scalars.push(e);
			} else if (e.k === "lit") {
				const key = `#${(e.node as ValueNode).value}`;
				if (plan.peel > 0 && !lits.some((l) => `#${(l.node as ValueNode).value}` === key)) {
					lits.push(e);
				}
			} else if (e.k === "op") {
				visit(e.left);
				visit(e.right);
			}
		};
		for (const lane of plan.lanes) {
			if (lane.kind === "store") visit(lane.value);
			else if (lane.kind === "temp_def") visit(lane.value);
			else if (lane.kind === "reduction") visit(lane.operand);
		}
		for (const e of scalars) scalar_splat_reg(e, splats);
		for (const e of lits) {
			if (splats.size >= SCALAR_SPLAT_REGS.length) break;
			splats.set(`#${(e.node as ValueNode).value}`, SCALAR_SPLAT_REGS[splats.size]);
		}
		for (const [key, reg] of splats) {
			const e = key.startsWith("#")
				? lits.find((l) => `#${(l.node as ValueNode).value}` === key)!
				: scalars.find((s) => s.name === key)!;
			if (plan.elem.float) {
				build_float_operand(e.node, d_of(reg), status);
				emit_asm(status, `dup ${reg}.2d, ${reg}.d[0]\n`);
			} else {
				build_node(e.node, status);
				ensure_newline(status);
				emit_asm(status, `dup ${reg}.${plan.elem.arr}, ${plan.elem.arr === "2d" ? "x0" : "w0"}\n`);
			}
		}
	}

	// lim = floor((bound - max_shift) / group_elems) double-groups. The
	// subtraction keeps every shifted read (last lane reads element
	// base + group - 1 + max_shift) inside the bound; negative bounds go
	// more negative (floor via asr) and the vector loop exits immediately.
	const label = `.Lneon_${neon_counter++}`;
	build_node(plan.bound_node, status);
	ensure_newline(status);
	if (plan.max_shift > 0) emit_asm(status, `sub x0, x0, #${plan.max_shift}\n`);
	emit_asm(status, `mov x9, x0\n`);
	emit_asm(status, `asr x9, x9, #${shift}\n`);
	emit_asm(status, `bic x9, x9, #1\n`);
	emit_asm(status, `mov x10, #0\n`);

	// Straight-line lane-group peel (plan.peel > 0): one guarded pass over
	// the first `peel` groups with zero loop machinery; the counted loop
	// below resumes at group `peel` when the guard passes (x10 starts at 0
	// otherwise), so no element is ever computed twice and big-N trips
	// keep their full vector coverage. x0 still holds bound - max_shift
	// here (mov/asr/bic are flag-neutral), so the guard is one compare +
	// branch; it also covers the negative-bound case (b.lt taken).
	if (plan.peel > 0) {
		const need = plan.peel * plan.elem.group_elems;
		const skip_label = `${label}_np`;
		emit_asm(status, `cmp x0, #${need}\n`);
		emit_asm(status, `b.lt ${skip_label}\n`);
		emit_neon_peel(plan, status, buffer_regs, shifted_regs, splats);
		emit_asm(status, `mov x10, #${plan.peel}\n`);
		emit_asm(status, `${skip_label}:\n`);
	}

	emit_asm(status, `${label}:\n`);
	emit_asm(status, `cmp x10, x9\n`);
	emit_asm(status, `b.hs ${label}_end\n`);
	for (const lane of plan.lanes)
		emit_lane_stmt(lane, status, plan, buffer_regs, shifted_regs, "x10", acc_regs, splats);
	emit_asm(status, `add x14, x10, #1\n`);
	for (const lane of plan.lanes)
		emit_lane_stmt(lane, status, plan, buffer_regs, shifted_regs, "x14", acc_regs, splats);
	emit_asm(status, `add x10, x10, #2\n`);
	emit_asm(status, `b ${label}\n`);
	emit_asm(status, `${label}_end:\n`);

	// Horizontal-combine each accumulator into its scalar and store — the
	// scalar tail continues from the combined value. Floats: FADDP (pair) or
	// the scalar FMUL element form. Integer `+` is wrap-exact under any
	// association, so no opt-in is needed: `.2d` combines with ADDP
	// (scalar), `.4s` with ADDV (add-across). The combined bits route
	// through x0 so `emit_var_store` can resolve slots, promoted x-regs or
	// promoted d-regs (float accumulators store directly from d0 — they can
	// only be slots or d-promoted).
	for (const r of plan.reductions) {
		const reg = acc_regs.get(r.name) ?? "v2";
		if (plan.elem.float) {
			if (r.op === "+") {
				emit_asm(status, `faddp d0, ${reg}.2d\n`);
			} else if (r.op === "min" || r.op === "max") {
				// Scalar minNum/maxNum across the two lanes — one rounding-free
				// combine (no accumulation order to preserve). The scalar
				// two-source form takes scalar registers, so the high lane
				// moves into a scratch d first.
				const mn = r.op === "min" ? "fminnm" : "fmaxnm";
				emit_asm(status, `mov d1, ${reg}.d[1]\n`);
				emit_asm(status, `${mn} d0, d${reg.slice(1)}, d1\n`);
			} else {
				emit_asm(status, `fmul d0, ${reg}.d[0], ${reg}.d[1]\n`);
			}
			emit_var_store(status, "d0", r.name, 8);
		} else if (plan.elem.arr === "2d") {
			emit_asm(status, `addp d0, ${reg}.2d\n`);
			emit_asm(status, `fmov x0, d0\n`);
			emit_var_store(status, "x0", r.name, 8);
		} else {
			emit_asm(status, `addv s0, ${reg}.4s\n`);
			emit_asm(status, `fmov w0, s0\n`);
			emit_var_store(status, "x0", r.name, 4);
		}
	}

	// Sync the induction: the scalar tail resumes at the vector loop's exit
	// counter (group units → element index). (int = 8-byte slot / x-reg.)
	emit_asm(status, `lsl x0, x10, #${shift}\n`);
	emit_var_store(status, "x0", plan.induction, 8);

	status.float_result_in_d0 = saved_d0;
	return true;
}

/**
 * Resident-kernel boundary sync (see plan_resident_kernel): the enclosing
 * loop's preheader loads every carried buffer's state into its v-registers
 * (using the identical pointer-pin sequence the vector emission uses, so
 * the addresses match), and the epilogue stores the registers back once
 * the enclosing loop has finished — the buffer's scalar consumers after
 * the loop (mandelbrot's escape check) read memory.
 */
export function emit_resident_preheader(plan: NeonPlan, status: BuildStatus): void {
	if (!plan.resident || plan.resident.length === 0) return;
	const buffer_regs = new Map<string, string>();
	plan.buffers.forEach((b, i) => {
		emit_buffer_struct_addr(b.node, status);
		const reg = BUFFER_PTR_REGS[i] ?? "x11";
		emit_asm(status, `ldr ${reg}, [x9, #8]\n`);
		buffer_regs.set(b.name, reg);
	});
	for (const c of plan.resident) {
		const base = buffer_regs.get(c.buffer) ?? "x11";
		for (let g = 0; g < 4; g++) {
			// 128-bit loads encode as the q-form (v16's q alias).
			emit_asm(status, `ldr q${c.vregs[g].slice(1)}, [${base}, #${g * 16}]\n`);
		}
	}
}

export function emit_resident_epilogue(plan: NeonPlan, status: BuildStatus): void {
	if (!plan.resident || plan.resident.length === 0) return;
	const buffer_regs = new Map<string, string>();
	plan.buffers.forEach((b, i) => {
		emit_buffer_struct_addr(b.node, status);
		const reg = BUFFER_PTR_REGS[i] ?? "x11";
		emit_asm(status, `ldr ${reg}, [x9, #8]\n`);
		buffer_regs.set(b.name, reg);
	});
	for (const c of plan.resident) {
		const base = buffer_regs.get(c.buffer) ?? "x11";
		for (let g = 0; g < 4; g++) {
			emit_asm(status, `str q${c.vregs[g].slice(1)}, [${base}, #${g * 16}]\n`);
		}
	}
}
