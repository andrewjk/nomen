/**
 * Loop-invariant branch if-conversion inside validated cycles
 * (ASM_PLAN_7 tranche 1: the spectral-norm `.while_4` receipt — 100% of
 * samples in a j-loop whose body carries `if transpose { denom += i + j +
 * 2 } else { denom += i + j + 1 }` as a cmp + branch + BOTH arms, every
 * iteration).
 *
 * Inside a call-free loop cycle, a two-arm if-diamond whose arms are
 * textually identical except ONE operand, and whose predicate plus both
 * operand values are loop-invariant (never defined in the cycle), is
 * rewritten to a select materialized once in the preheader:
 *
 *     cmp xP, #imm              ; hoisted before the header label
 *     csel xM, A, B, <not cc>   ; runs once — the branch is gone
 *     .while_N:
 *       …
 *       <merged arm: B rewritten to xM>
 *       …
 *
 * so the per-iteration cost of the diamond (compare, conditional branch,
 * one arm's worth of instructions) collapses to the single merged arm.
 * When the differing operands are immediates, the preheader materializes
 * the choice with a once-only mov pair behind a branch (still runs once):
 *
 *     cmp xP, #imm / mov xM, #B / b.<cc> .ifc_N / mov xM, #A / .ifc_N:
 *
 * Soundness model:
 *
 * - The containing cycle is validated like promote_loop_slots: header
 *   label L with an unconditional back-edge `b L` (header provenance:
 *   every jump to L originates inside), no bl/blr/br/svc/ret inside, and
 *   — stricter here — every jump TARGET inside the cycle range is the
 *   header or one of the diamond's own two labels, each targeted only by
 *   the diamond's own branches. Single entry: the preheader inserts
 *   before the header label, reachable only by fall-through (the
 *   entry-load argument) — the cmp+csel run exactly once per loop entry,
 *   and the back-edge skips them. (Even a degenerate "cycle" — a dead
 *   back-edge — stays correct: the region is single-entry, so nothing
 *   reaches the merged arm without passing the materialized select, and
 *   the invariance scan is what carries the proof.)
 * - Invariance: the predicate register and both differing operands are
 *   not defined anywhere in the cycle (w/x siblings share fate — a w
 *   write changes the x view a cmp reads). Their preheader values
 *   therefore equal their values on every iteration.
 * - The select register (x16/x17 — the intra-statement scratch pool,
 *   never live across statements in emitter output) appears nowhere in
 *   the cycle, so the merged arm's read cannot be clobbered. This pass
 *   runs AFTER promote_loop_slots: a promoted rename in the cycle simply
 *   removes that register from this pool.
 * - Arm equality is verified BOTH structurally (same op, same operand
 *   shapes, exactly one differing operand position) and textually (the
 *   stripped lines are byte-identical except that one operand token —
 *   dropped shift qualifiers cannot hide a difference). The differing
 *   operand is never a destination (defs are leading-register only) and
 *   never a memory operand; A/B are 64-bit x-form GPRs (csel is
 *   int-only here and widths must match the x-form select register).
 * - Path-merge exactness: the merged arm IS the else arm with B→xM; on
 *   the then path csel made xM == A, and every other instruction and
 *   memory access is identical on both paths — no loads/stores are
 *   reordered, so no aliasing question arises. The only flag reader in
 *   the diamond (the conditional branch) is deleted; the hoisted cmp
 *   feeds only the csel sitting directly after it (the lift's flag
 *   discipline: labels reset known flags, and the pair is adjacent).
 * - Arms containing any control transfer refuse; the `else_L:` label is
 *   deleted with the diamond scaffolding (its only jumper was the
 *   deleted branch); `end_L:` stays (untargeted fall-through marker,
 *   which also re-validates the cycle for eliminate_dead_cycle_moves).
 *
 * Runs AFTER coalesce_copies and BEFORE eliminate_dead_cycle_moves —
 * the merge turns the cycle label-clean, letting that pass price the
 * staging moves the diamond used to shield (`mov x0, x12`,
 * `mov x2, x26`, …). Kill-switch: `set_if_conversion_enabled(false)`
 * returns the text unchanged.
 */

import type { AsmInstruction, Operand } from "./asm_ir.ts";
import { is_cond } from "./asm_ir.ts";
import { parse_asm_instruction } from "./lift_asm.ts";

let if_convert_on = true;

export function if_conversion_enabled(): boolean {
	return if_convert_on;
}

export function set_if_conversion_enabled(enabled: boolean): void {
	if_convert_on = enabled;
}

const LABEL_LINE_RE = /^([A-Za-z_.$][\w.$]*|\d+):$/;
const NUMERIC_LABEL_RE = /^\d+$/;
const B_ALIAS_RE = /^(eq|ne|lt|le|gt|ge|hs|lo|ls|hi|mi|pl)$/;
const NUM_TARGET_RE = /^(\d+)([fb])$/;

/** Condition-code negation (the hoisted cmp pairs with the inverted
 *  select condition, preserving flag provenance). */
const NEGATE_COND: Record<string, string> = {
	eq: "ne",
	ne: "eq",
	hs: "lo",
	lo: "hs",
	hi: "ls",
	ls: "hi",
	gt: "le",
	le: "gt",
	ge: "lt",
	lt: "ge",
	mi: "pl",
	pl: "mi",
};

/** The select-register pool: the same intra-statement scratch the slot
 *  promotion uses (never live across statements in emitter output). */
const SELECT_REGS = ["x16", "x17"];

/** Registers that may not act as predicate holder or differing operand
 *  (frame/link/stack pointers and the zero register). */
const FORBIDDEN_OPERAND_REGS = new Set(["sp", "xzr", "x29", "x30", "fp", "lr"]);

function strip_comment(line: string): string {
	const idx = line.indexOf("//");
	return idx === -1 ? line : line.slice(0, idx);
}

function is_branch_op(op: string): boolean {
	if (op === "b" || op === "cbz" || op === "cbnz" || op === "tbz" || op === "tbnz") return true;
	if (op === "bl" || op === "blr" || op === "br" || op === "ret") return false;
	if (op.startsWith("b.")) return true;
	return op[0] === "b" && op.length > 1 && B_ALIAS_RE.test(op.slice(1));
}

function is_control_transfer(op: string): boolean {
	return is_branch_op(op) || op === "bl" || op === "blr" || op === "br" || op === "ret";
}

/** The condition code of a conditional branch (`b.eq` / alias `beq`),
 *  null for unconditional/non-branch ops. */
function cond_branch_cc(op: string): string | null {
	if (op.startsWith("b.") && is_cond(op.slice(2))) return op.slice(2);
	if (op[0] === "b" && op.length > 1 && B_ALIAS_RE.test(op.slice(1))) return op.slice(1);
	return null;
}

/** Registers an instruction WRITES (exact, dest-first; stores/compares/
 *  branches define nothing; ldp defines both leading registers). Shared
 *  with the sibling asm-level passes (remat) so lift semantics stay in
 *  one place. */
export function exact_defs(instr: AsmInstruction): string[] {
	switch (instr.op) {
		case "str":
		case "strb":
		case "strh":
		case "stur":
		case "sturb":
		case "sturh":
		case "stp":
		case "cmp":
		case "tst":
		case "cmn":
		case "ret":
			return [];
		case "ldp": {
			const defs: string[] = [];
			for (const o of instr.operands) {
				if (o.kind === "reg") {
					defs.push(o.name);
					if (defs.length === 2) break;
				} else break;
			}
			return defs;
		}
		default:
			break;
	}
	// Branch-test forms read their register operands (cbz/cbnz/tbz/tbnz
	// do NOT start with "b" — without this they would read as dest-first
	// definitions of their predicate register).
	if (instr.op === "cbz" || instr.op === "cbnz" || instr.op === "tbz" || instr.op === "tbnz") {
		return [];
	}
	if (instr.op.startsWith("b")) return [];
	for (const o of instr.operands) {
		if (o.kind === "reg") return [o.name];
		if (o.kind === "mem" || o.kind === "cond" || o.kind === "imm" || o.kind === "label") break;
	}
	return [];
}

/** Every register an instruction touches (operands, memory base/index). */
export function instr_regs(instr: AsmInstruction): string[] {
	const out: string[] = [];
	for (const o of instr.operands) {
		if (o.kind === "reg") out.push(o.name);
		else if (o.kind === "mem") {
			out.push(o.base);
			if (o.offset?.kind === "reg") out.push(o.offset.name);
		}
	}
	return out;
}

function sibling_reg(name: string): string | null {
	if (/^w\d+$/.test(name)) return `x${name.slice(1)}`;
	if (/^x\d+$/.test(name)) return `w${name.slice(1)}`;
	return null;
}

/** Whether the instruction defines any of the tracked names, with w/x
 *  siblings sharing fate (a w write changes the x view and vice versa). */
function defines_any(instr: AsmInstruction, names: Set<string>): boolean {
	for (const d of exact_defs(instr)) {
		if (names.has(d)) return true;
		const sib = sibling_reg(d);
		if (sib && names.has(sib)) return true;
	}
	return false;
}

function operand_equal(a: Operand, b: Operand): boolean {
	if (a.kind !== b.kind) return false;
	switch (a.kind) {
		case "reg":
			return a.name === (b as typeof a).name;
		case "imm":
			return a.value === (b as typeof a).value;
		case "label":
			return a.name === (b as typeof a).name;
		case "cond":
			return a.code === (b as typeof a).code;
		case "mem": {
			const m = b as typeof a;
			if (a.base !== m.base || a.scale !== m.scale || a.writeback !== m.writeback) return false;
			if ((a.postOffset ?? null) !== (m.postOffset ?? null)) return false;
			const ao = a.offset;
			const bo = m.offset;
			if ((ao?.kind ?? null) !== (bo?.kind ?? null)) return false;
			if (ao?.kind === "imm" && bo?.kind === "imm") return ao.value === bo.value;
			if (ao?.kind === "reg" && bo?.kind === "reg") return ao.name === bo.name;
			return true;
		}
		default:
			return false;
	}
}

function escape_re(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The innermost validated cycle (header line h, back-edge line e)
 *  strictly containing [test_idx, end_line], or null. Header provenance
 *  from inside, no calls/indirect transfers inside, and every jump
 *  target inside the range is the diamond's own else/end label. Shared
 *  with the sibling asm-level passes (remat). */
export function find_containing_cycle(
	labels: Map<string, number[]>,
	jumps: { from: number; target: number | null; cond: boolean }[],
	parsed: (AsmInstruction | null)[],
	test_idx: number,
	end_line: number,
): { h: number; e: number } | null {
	const candidates: { h: number; e: number }[] = [];
	for (const [name, ps] of labels) {
		if (NUMERIC_LABEL_RE.test(name) || ps.length !== 1) continue;
		const h = ps[0];
		if (h >= test_idx) continue;
		for (const j of jumps) {
			if (j.target !== h || j.cond || j.from <= h || j.from <= end_line) continue;
			candidates.push({ h, e: j.from });
		}
	}
	// Tightest containing range first (innermost binding).
	candidates.sort((a, b) => a.e - a.h - (b.e - b.h));
	for (const { h, e } of candidates) {
		let ok = true;
		for (const j2 of jumps) {
			if (j2.target === h && !(j2.from > h && j2.from <= e)) ok = false;
		}
		if (!ok) continue;
		for (let k = h + 1; k < e && ok; k++) {
			const c = parsed[k];
			if (!c) continue;
			if (c.op === "bl" || c.op === "blr" || c.op === "br" || c.op === "svc" || c.op === "ret") {
				ok = false;
			}
		}
		if (!ok) continue;
		// Single entry: every jump whose target sits inside the range must
		// originate inside — an outside jump into the region would be a
		// second entry that bypasses the preheader materialization.
		// (Inside-targeting internal branches — a sibling diamond's
		// labels, say — are fine; the diamond's own labels additionally
		// passed the exactly-one-jumper provenance check above.)
		for (const j3 of jumps) {
			if (j3.target === null) continue;
			if (j3.target > h && j3.target < e && !(j3.from > h && j3.from <= e)) {
				ok = false;
			}
		}
		if (ok) return { h, e };
	}
	return null;
}

/** One conversion attempt over the whole text: find the FIRST eligible
 *  diamond, apply it, return the new text; null when nothing converts.
 *  (One per round keeps every index valid; the caller iterates.) */
function convert_one(code: string): string | null {
	const lines = code.split("\n");
	const n = lines.length;
	const parsed: (AsmInstruction | null)[] = Array.from({ length: n }, () => null);
	const labels = new Map<string, number[]>();
	const jumps: { from: number; token: string; target: number | null; cond: boolean }[] = [];

	for (let i = 0; i < n; i++) {
		const t = lines[i].trim();
		const lm = LABEL_LINE_RE.exec(t);
		if (lm) {
			const ps = labels.get(lm[1]);
			if (ps) ps.push(i);
			else labels.set(lm[1], [i]);
			continue;
		}
		if (!t || t.startsWith("//") || t.startsWith(".") || /^[\w.$]+\s*=\s*[\w.$]+$/.test(t)) {
			continue;
		}
		const instr = parse_asm_instruction(lines[i], i + 1);
		if (!instr) continue;
		parsed[i] = instr;
		if (is_branch_op(instr.op)) {
			const target = instr.operands.find((o) => o.kind === "label");
			if (!target || target.kind !== "label") return null;
			jumps.push({ from: i, token: target.name, target: null, cond: instr.op !== "b" });
		}
	}

	const resolve_target = (token: string, from: number): number | null => {
		const num = NUM_TARGET_RE.exec(token);
		if (num) {
			const ps = labels.get(num[1]);
			if (!ps) return null;
			if (num[2] === "f") {
				for (const p of ps) if (p > from) return p;
				return null;
			}
			for (let k = ps.length - 1; k >= 0; k--) if (ps[k] < from) return ps[k];
			return null;
		}
		const ps = labels.get(token);
		return ps && ps.length > 0 ? ps[0] : null;
	};
	for (const j of jumps) j.target = resolve_target(j.token, j.from);

	for (let i = 0; i < n; i++) {
		const instr = parsed[i];
		if (!instr) continue;

		let branch_idx: number;
		let cc: string;
		let pred: string;
		let test_text: string;
		let else_token: string;
		if (
			instr.op === "cmp" &&
			instr.operands.length === 2 &&
			instr.operands[0].kind === "reg" &&
			instr.operands[1].kind === "imm"
		) {
			const branch = parsed[i + 1];
			const bcc = branch ? cond_branch_cc(branch.op) : null;
			if (!branch || !bcc) continue;
			const target = branch.operands.find((o) => o.kind === "label");
			if (!target || target.kind !== "label") continue;
			else_token = target.name;
			if (NUMERIC_LABEL_RE.test(else_token)) continue;
			const ps = labels.get(else_token);
			if (!ps || ps.length !== 1) continue;
			branch_idx = i + 1;
			cc = bcc;
			pred = instr.operands[0].name;
			test_text = strip_comment(lines[i]).trim();
		} else if (instr.op === "cbz" || instr.op === "cbnz") {
			if (
				instr.operands.length !== 2 ||
				instr.operands[0].kind !== "reg" ||
				instr.operands[1].kind !== "label"
			) {
				continue;
			}
			else_token = instr.operands[1].name;
			if (NUMERIC_LABEL_RE.test(else_token)) continue;
			const ps = labels.get(else_token);
			if (!ps || ps.length !== 1) continue;
			branch_idx = i;
			cc = instr.op === "cbz" ? "eq" : "ne";
			pred = instr.operands[0].name;
			test_text = `cmp ${pred}, #0`;
		} else {
			continue;
		}
		if (FORBIDDEN_OPERAND_REGS.has(pred)) continue;

		const else_line = labels.get(else_token)![0];
		const jump_end_idx = else_line - 1;
		if (jump_end_idx <= branch_idx) continue;
		const b_end = parsed[jump_end_idx];
		if (
			!b_end ||
			b_end.op !== "b" ||
			b_end.operands.length !== 1 ||
			b_end.operands[0].kind !== "label"
		) {
			continue;
		}
		const end_token = b_end.operands[0].name;
		if (NUMERIC_LABEL_RE.test(end_token)) continue;
		const end_ps = labels.get(end_token);
		if (!end_ps || end_ps.length !== 1) continue;
		const end_line = end_ps[0];
		if (end_line < else_line + 2) continue;

		const then_start = branch_idx + 1;
		const then_end = else_line - 2;
		const else_start = else_line + 1;
		const else_end = end_line - 1;
		if (then_end - then_start !== else_end - else_start) continue;

		// The diamond's labels are targeted ONLY by its own branches.
		let provenance_ok = true;
		for (const j of jumps) {
			if (j.target === else_line && j.from !== branch_idx) provenance_ok = false;
			if (j.target === end_line && j.from !== jump_end_idx) provenance_ok = false;
		}
		if (!provenance_ok) continue;

		// Arms: fully parsed, identical length, no control transfer.
		const arm_len = then_end - then_start + 1;
		let arms_ok = true;
		for (let k = 0; k < arm_len; k++) {
			const a = parsed[then_start + k];
			const b = parsed[else_start + k];
			if (!a || !b || is_control_transfer(a.op) || is_control_transfer(b.op)) {
				arms_ok = false;
				break;
			}
		}
		if (!arms_ok) continue;

		// Exactly one differing operand position, structurally.
		let diff_offset = -1;
		let diff_pos = -1;
		let rejected = false;
		for (let k = 0; k < arm_len && !rejected; k++) {
			const a = parsed[then_start + k];
			const b = parsed[else_start + k];
			if (!a || !b) {
				rejected = true;
				break;
			}
			if (a.op !== b.op || a.operands.length !== b.operands.length) {
				rejected = true;
				break;
			}
			for (let p = 0; p < a.operands.length; p++) {
				if (!operand_equal(a.operands[p], b.operands[p])) {
					if (diff_offset !== -1) {
						rejected = true;
						break;
					}
					diff_offset = k;
					diff_pos = p;
				}
			}
		}
		if (rejected || diff_offset < 0) continue;

		const diff_then = parsed[then_start + diff_offset];
		const diff_else = parsed[else_start + diff_offset];
		if (!diff_then || !diff_else) continue;
		const a_op = diff_then.operands[diff_pos];
		const b_op = diff_else.operands[diff_pos];
		const is_imm_diff = a_op.kind === "imm" && b_op.kind === "imm";
		let a_name = "";
		let b_name = "";
		if (is_imm_diff) {
			// The preheader mov must encode: gate to the movz immediate set.
			if (
				a_op.value < 0n ||
				a_op.value > 65535n ||
				b_op.value < 0n ||
				b_op.value > 65535n ||
				a_op.value === b_op.value
			) {
				continue;
			}
		} else if (a_op.kind === "reg" && b_op.kind === "reg") {
			// x-form 64-bit GPRs only (csel widths must match the select
			// register), never a destination position, never fp/lr/sp.
			if (!/^x\d+$/.test(a_op.name) || !/^x\d+$/.test(b_op.name)) continue;
			if (diff_pos === 0 && exact_defs(diff_then).length > 0) continue;
			if (FORBIDDEN_OPERAND_REGS.has(a_op.name) || FORBIDDEN_OPERAND_REGS.has(b_op.name)) {
				continue;
			}
			a_name = a_op.name;
			b_name = b_op.name;
		} else {
			continue;
		}

		// Textual verification: the stripped lines are byte-identical
		// except the single differing token (dropped shift qualifiers
		// cannot hide a difference), and each replacement is unambiguous.
		let text_ok = true;
		for (let k = 0; k < arm_len; k++) {
			if (k === diff_offset) continue;
			if (
				strip_comment(lines[then_start + k]).trim() !== strip_comment(lines[else_start + k]).trim()
			) {
				text_ok = false;
				break;
			}
		}
		if (!text_ok) continue;
		const ta = strip_comment(lines[then_start + diff_offset]).trim();
		const tb = strip_comment(lines[else_start + diff_offset]).trim();
		const a_token = is_imm_diff ? a_op.raw : a_name;
		const b_token = is_imm_diff ? b_op.raw : b_name;
		const a_re = new RegExp(
			is_imm_diff ? `${escape_re(a_token)}(?![0-9A-Za-z])` : `\\b${a_token}\\b`,
			"g",
		);
		const b_re = new RegExp(
			is_imm_diff ? `${escape_re(b_token)}(?![0-9A-Za-z])` : `\\b${b_token}\\b`,
			"g",
		);
		if ((ta.match(a_re) ?? []).length !== 1) continue;
		if ((tb.match(b_re) ?? []).length !== 1) continue;
		if (ta.replace(a_re, b_token) !== tb) continue;

		const header = find_containing_cycle(labels, jumps, parsed, i, end_line);
		if (header === null) continue;

		// Loop invariance: the predicate and both operands are defined
		// NOWHERE in the cycle (siblings share fate).
		const invariant = new Set([pred, a_token, b_token]);
		let cycle_ok = true;
		for (let j = header.h + 1; j < header.e; j++) {
			const c = parsed[j];
			if (!c) continue;
			if (defines_any(c, invariant)) {
				cycle_ok = false;
				break;
			}
		}
		if (!cycle_ok) continue;

		// Select register: nowhere in the cycle.
		const used = new Set<string>();
		for (let j = header.h + 1; j < header.e; j++) {
			const c = parsed[j];
			if (!c) continue;
			for (const r of instr_regs(c)) used.add(r);
		}
		const select_reg = SELECT_REGS.find((r) => !used.has(r));
		if (!select_reg) continue;

		// Eligible. Apply.
		const kept_line = lines[else_start + diff_offset];
		const kept_re = is_imm_diff
			? new RegExp(`${escape_re(b_token)}(?![0-9A-Za-z])`)
			: new RegExp(`\\b${b_token}\\b`);
		lines[else_start + diff_offset] = kept_line.replace(kept_re, select_reg);

		// Delete the scaffolding: test, branch, then arm, `b end_L`, and
		// the `else_L:` label. `end_L:` stays (untargeted fall-through
		// marker; landing there equals landing after the arm).
		lines.splice(i, else_line - i + 1);

		// Preheader before the header label — fall-through entry runs it
		// once; the back-edge skips it. (header_idx < test_idx, so the
		// splices above did not move it.)
		const indent = lines[header.h].match(/^\s*/)?.[0] ?? "";
		const pre: string[] = [`${indent}${test_text}`];
		if (is_imm_diff) {
			let ifc_n = 0;
			while (labels.has(`.ifc_${ifc_n}`)) ifc_n++;
			const ifc = `.ifc_${ifc_n}`;
			pre.push(`${indent}mov ${select_reg}, #${b_op.value}`);
			pre.push(`${indent}b.${cc} ${ifc}`);
			pre.push(`${indent}mov ${select_reg}, #${a_op.value}`);
			pre.push(`${indent}${ifc}:`);
		} else {
			const notcc = NEGATE_COND[cc] ?? "ne";
			pre.push(`${indent}csel ${select_reg}, ${a_name}, ${b_name}, ${notcc}`);
		}
		lines.splice(header.h, 0, ...pre);
		return lines.join("\n");
	}

	return null;
}

export function convert_loop_invariant_branches(code: string): string {
	if (!if_convert_on) return code;
	for (let round = 0; round < 8; round++) {
		const next = convert_one(code);
		if (next === null) return code;
		code = next;
	}
	return code;
}
