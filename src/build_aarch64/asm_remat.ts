/**
 * Constant rematerialization (ASM_PLAN_7 tranche 4): memory-materialized
 * constants inside loops become register immediates. The spectral-norm
 * receipt — `adr x3, _float_op_4; ldr d18, [x3]` EVERY iteration for the
 * literal `1.0`, where clang materializes `fmov d0, #1.0` once — three
 * independent rewrites:
 *
 * 1. Float pair collapse: `adr xR, LABEL` + `ldr dX, [xR]` whose LABEL is
 *    a `.double` literal pool entry holding an FP modified-immediate value
 *    becomes `fmov dX, #imm` in place (2 instructions + an L1 access →
 *    1 instruction, no memory).
 * 2. Loop hoist: an `fmov dX, #imm` inside a validated cycle whose
 *    destination has no other definition in the cycle and appears nowhere
 *    else in the function moves to the preheader under a fresh d-register
 *    (d16–d31, unused in ANY form in the whole function), with every
 *    in-cycle read renamed — clang's once-per-loop materialization.
 * 3. Int literal pool loads: `ldr xN, =K` with K in movz/movn range
 *    becomes `mov xN, #K` — no literal-pool word, no memory access.
 *
 * Soundness model:
 *
 * - Pair collapse deletes the `adr xR`, so every path that read the
 *   address before a redefinition would now read a stale register. The
 *   verdict is EXACT CFG liveness over the rewritten text (the same
 *   block/edge/fixpoint machinery the dead-cycle-move pass uses): the
 *   pair is deleted only when xR is dead immediately before the inserted
 *   `fmov` — no path from that point reads xR (either register view)
 *   before a new definition, so no reader can observe the deleted def.
 *   Candidates sharing a staging register settle one round at a time
 *   (each verdict prices the OTHER pairs' ldr reads — a shared-register
 *   sibling still holding its pair keeps this one refused).
 * - The FP immediate set is the hardware's: ±m/16 × 2^e for m in [16,31],
 *   e in [-3,4]. Anything else (3.14, exponents, −0.0) keeps the pool load.
 * - The hoist reuses the if-conversion cycle validator (header provenance
 *   from inside, no calls, single entry): the preheader fmov runs exactly
 *   once per loop entry and dominates every in-cycle read. The destination
 *   has no other in-cycle definition and no occurrence outside the cycle,
 *   so the rename cannot cross a def or a stray reader. The fresh register
 *   is textually absent from the whole function in every form (d/s/q/v) —
 *   a v-register alias can never hide in the expression-tree pool — and
 *   the pool is caller-saved (d16–d31), so no prologue save is owed.
 * - Int remat defines exactly what the load defined; the movz/movn range
 *   gate keeps the assembler-encodability.
 *
 * Runs AFTER coalesce_copies/if-conversion and BEFORE
 * eliminate_dead_cycle_moves — deleting the in-loop constant kill lets
 * that pass price the staging moves the pool load used to shield.
 * Kill-switch: `set_const_remat_enabled(false)` returns the text
 * unchanged (byte-identical off arm).
 */

import {
	ALL_TRACKED,
	analyze_function_at,
	exact_defs,
	function_chunk_start,
	transfer,
	type Analysis,
} from "./asm_cycle_dead_moves.ts";
import { find_containing_cycle, instr_regs } from "./asm_if_convert.ts";
import type { AsmInstruction } from "./asm_ir.ts";
import { parse_asm_instruction } from "./lift_asm.ts";

let remat_on = true;

export function const_remat_enabled(): boolean {
	return remat_on;
}

export function set_const_remat_enabled(enabled: boolean): void {
	remat_on = enabled;
}

const LABEL_LINE_RE = /^([A-Za-z_.$][\w.$]*|\d+):$/;
const NUM_TARGET_RE = /^(\d+)([fb])$/;

/** `.double` constant-pool entries: label → numeric value. ONLY the
 *  compiler's literal pools qualify — a top-level `var float f` also
 *  emits a `.double` data line named after the VARIABLE, and its
 *  `adr+ldr` accesses are mutable loads, not constants. */
const POOL_LABEL_RE = /^_(?:float_op|float_const|float_lit)_\d+$/;

function collect_double_labels(code: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const line of code.split("\n")) {
		const t = line.trim();
		const m = /^([A-Za-z_.$][\w.$]*):\s*\.double\s+(\S+)\s*$/.exec(t);
		if (m && POOL_LABEL_RE.test(m[1])) out.set(m[1], Number(m[2]));
	}
	return out;
}

/** The FP modified-immediate set: ±m/16 × 2^e, m ∈ [16,31], e ∈ [-3,4],
 *  plus ±0 (its own encoding). Every member is exactly representable, so
 *  the comparison is exact. Negative zero keeps the pool load — the
 *  immediate form would print sign-less and flip `1/x`-style results. */
export function fmov_encodable(value: number): boolean {
	if (!Number.isFinite(value)) return false;
	if (value === 0) return !Object.is(value, -0);
	for (let e = -3; e <= 4; e++) {
		for (let m = 16; m <= 31; m++) {
			const pos = (m / 16) * 2 ** e;
			if (Object.is(value, pos) || Object.is(value, -pos)) return true;
		}
	}
	return false;
}

/** Canonical immediate text — an explicit decimal point keeps the FP
 *  immediate form (an integer-looking token could parse as a movz). */
function fmt_double(value: number): string {
	return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

function escape_re(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One float-pool collapse candidate. */
interface PairCandidate {
	adr_idx: number;
	xR: string;
	dX: string;
	value: number;
}

/** The `adr xR, LABEL` + `ldr dX, [xR]` shape with an encodable pool
 *  value — at most one per staging register per round. */
function find_pair_candidates(lines: string[], doubles: Map<string, number>): PairCandidate[] {
	const parsed: (AsmInstruction | null)[] = lines.map((l, i) => parse_asm_instruction(l, i + 1));
	const out: PairCandidate[] = [];
	const seen_xr = new Set<string>();
	for (let i = 0; i < parsed.length - 1; i++) {
		const adr = parsed[i];
		const ldr = parsed[i + 1];
		if (!adr || !ldr || adr.op !== "adr" || ldr.op !== "ldr") continue;
		if (
			adr.operands.length !== 2 ||
			adr.operands[0].kind !== "reg" ||
			adr.operands[1].kind !== "label"
		) {
			continue;
		}
		const xR = adr.operands[0].name;
		if (!/^x\d+$/.test(xR) || xR === "xzr" || seen_xr.has(xR)) continue;
		if (
			ldr.operands.length !== 2 ||
			ldr.operands[0].kind !== "reg" ||
			ldr.operands[1].kind !== "mem"
		) {
			continue;
		}
		const dX = ldr.operands[0].name;
		const mem = ldr.operands[1];
		if (!/^d\d+$/.test(dX)) continue;
		if (
			mem.base !== xR ||
			mem.offset ||
			mem.scale ||
			mem.writeback ||
			mem.postOffset !== undefined
		) {
			continue;
		}
		const value = doubles.get(adr.operands[1].name);
		if (value === undefined || !fmov_encodable(value)) continue;
		out.push({ adr_idx: i, xR, dX, value });
		seen_xr.add(xR);
	}
	return out;
}

/** Rebuild `lines` with the given candidates collapsed (adr+ldr → fmov).
 *  `fmov_at[ordinal]` receives each inserted fmov's output line index. */
function apply_pairs(lines: string[], cands: PairCandidate[], fmov_at?: number[]): string[] {
	const by_adr = new Map(cands.map((c) => [c.adr_idx, c]));
	const out: string[] = [];
	let skip_next = false;
	for (let i = 0; i < lines.length; i++) {
		if (skip_next) {
			skip_next = false;
			continue;
		}
		const c = by_adr.get(i);
		if (c) {
			fmov_at?.push(out.length);
			out.push(`fmov ${c.dX}, #${fmt_double(c.value)}`);
			skip_next = true; // the pair's ldr line dies with it
			continue;
		}
		out.push(lines[i]);
	}
	return out;
}

/**
 * Exact liveness with one refinement over the shared analysis: a call's
 * ABI argument reads (the x0–x8 slots transfer() adds) do NOT observe the
 * candidates' staging registers. Every argument a callee actually reads
 * is written at the call site (emitter contract), so an unwritten arg
 * slot carries garbage the callee never touches — the deleted pool
 * address cannot leak through it. Without this, every loop feeding a
 * call would refuse (all eight arg slots read = live).
 */
function live_before_fmov(a: Analysis, f: number, exclude_arg_reads: Set<string>): Set<string> {
	const step = (instr: AsmInstruction, live: Set<string>): void => {
		if (instr.op === "bl" || instr.op === "blr") {
			for (let x = 0; x <= 17; x++) live.delete(`x${x}`);
			live.delete("x30");
			for (let d = 0; d <= 7; d++) live.delete(`d${d}`);
			for (let x = 0; x <= 8; x++) {
				if (!exclude_arg_reads.has(`x${x}`)) live.add(`x${x}`);
				live.add(`d${x}`);
			}
			return;
		}
		transfer(instr, live);
	};
	const live_in: Set<string>[] = a.blocks.map(() => new Set<string>());
	let changed = true;
	while (changed) {
		changed = false;
		for (let bi = a.blocks.length - 1; bi >= 0; bi--) {
			const blk = a.blocks[bi];
			const live = new Set<string>();
			for (const s of blk.succ) {
				for (const r of live_in[s]) live.add(r);
			}
			for (let i = blk.end; i >= blk.start; i--) {
				if (a.kind[i] !== "instr") continue;
				if (a.parsed[i]) step(a.parsed[i]!, live);
				else for (const r of ALL_TRACKED) live.add(r);
			}
			if (live.size !== live_in[bi].size || [...live].some((r) => !live_in[bi].has(r))) {
				live_in[bi] = live;
				changed = true;
			}
		}
	}
	const blk = a.line_block[f];
	const live = new Set<string>();
	for (const s of a.blocks[blk].succ) {
		for (const r of live_in[s]) live.add(r);
	}
	for (let k = a.blocks[blk].end; k > f; k--) {
		if (a.kind[k] !== "instr") continue;
		if (a.parsed[k]) step(a.parsed[k]!, live);
		else for (const r of ALL_TRACKED) live.add(r);
	}
	return live;
}

/**
 * Phase 1 — collapse `adr xR, LABEL` + `ldr dX, [xR]` pairs into
 * `fmov dX, #imm` when xR is provably dead after the pair (exact liveness
 * over the rewritten text, call-arg slots excluded — see
 * live_before_fmov). One settle-round per staging register.
 */
function remat_float_pairs(code: string): string {
	const doubles = collect_double_labels(code);
	if (doubles.size === 0) return code;
	for (let round = 0; round < 8; round++) {
		const lines = code.split("\n");
		const cands = find_pair_candidates(lines, doubles);
		if (cands.length === 0) break;
		// Trial: every candidate collapsed; the liveness verdict for each
		// is computed at its inserted fmov, analyzing ONLY the candidate's
		// function chunk (control flow cannot cross a ret, so the per-
		// function result is exact — and a fraction of the whole-text cost).
		const fmov_line: number[] = [];
		const trial = apply_pairs(lines, cands, fmov_line);
		const trial_code = trial.join("\n");
		const exclude = new Set(cands.map((c) => c.xR));
		const chunk_memo = new Map<number, { a: Analysis; offset: number } | null>();
		const winners: PairCandidate[] = [];
		for (let ci = 0; ci < cands.length; ci++) {
			const f = fmov_line[ci];
			if (f === undefined) continue;
			const chunk = function_chunk_start(trial, f);
			let entry = chunk_memo.get(chunk);
			if (entry === undefined) {
				entry = analyze_function_at(trial_code, f);
				chunk_memo.set(chunk, entry);
			}
			if (!entry) continue;
			const live = live_before_fmov(entry.a, f - entry.offset, exclude);
			// Dead in BOTH register views → no reader observes the deleted
			// address def on any path → collapse is invisible.
			const c = cands[ci];
			if (!live.has(c.xR) && !live.has(`w${c.xR.slice(1)}`)) winners.push(c);
		}
		if (winners.length === 0) break;
		code = apply_pairs(lines, winners).join("\n");
	}
	return code;
}

/** Label/jump tables for the cycle validator — the same parse discipline
 *  the if-conversion pass uses (one label position map, resolved jumps). */
function build_tables(code: string): {
	parsed: (AsmInstruction | null)[];
	labels: Map<string, number[]>;
	jumps: { from: number; token: string; target: number | null; cond: boolean }[];
} {
	const lines = code.split("\n");
	const parsed: (AsmInstruction | null)[] = new Array(lines.length).fill(null);
	const labels = new Map<string, number[]>();
	const jumps: { from: number; token: string; target: number | null; cond: boolean }[] = [];
	for (let i = 0; i < lines.length; i++) {
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
		const is_branch =
			instr.op === "b" || instr.op.startsWith("b.") || instr.op === "cbz" || instr.op === "cbnz";
		if (is_branch) {
			const target = instr.operands.find((o) => o.kind === "label");
			if (!target || target.kind !== "label") continue;
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
	return { parsed, labels, jumps };
}

/**
 * Phase 2 — hoist one in-cycle `fmov dX, #imm` to the preheader under a
 * fresh register, renaming the in-cycle reads the fmov reaches. One per
 * round keeps the indexes valid; the caller iterates.
 *
 * The rename scope ends at the next instruction that DEFINES dX (the
 * three-operand consume-and-redefine shape — `fdiv d17, d17, d0` reading
 * the constant and writing the result into the same register — is the
 * common case, so "no other defs in the cycle" would never fire). A label
 * between the fmov and the scope end refuses: a jump into that region
 * could reach a renamed read without the fmov having run, and there dX
 * held a different value (dM always holds the constant — wrong for it).
 */
function hoist_one_fmov(code: string): string | null {
	const lines = code.split("\n");
	const { parsed, labels, jumps } = build_tables(code);

	// Registers textually present in ANY form (d/s/q/v share the physical
	// file — a v18.2d use makes d18 unsafe as a hoist destination).
	const present = (m: number): boolean => {
		const re = new RegExp(`\\b(?:d|s|q|v)${m}\\b`);
		return re.test(code);
	};

	for (let i = 0; i < parsed.length; i++) {
		const instr = parsed[i];
		if (!instr || instr.op !== "fmov" || instr.operands.length !== 2) continue;
		const [dst, imm] = instr.operands;
		if (dst.kind !== "reg" || !/^d\d+$/.test(dst.name)) continue;
		if (imm.kind !== "imm" || !imm.raw.includes(".")) continue; // FP immediate form only
		const dX = dst.name;

		const header = find_containing_cycle(labels, jumps, parsed, i, i);
		if (!header) continue;
		const { h, e } = header;

		// Rename scope: (i, J] where J is the next dX definition — or the
		// cycle end. A label (or any other unparseable line) in between
		// refuses.
		let J = -1;
		let label_between = false;
		for (let k = i + 1; k < e; k++) {
			const c = parsed[k];
			if (!c) {
				const t = lines[k].trim();
				if (!t || t.startsWith("//") || t.startsWith(".")) continue;
				label_between = true; // a label: another path may skip the fmov
				break;
			}
			if (exact_defs(c).includes(dX)) {
				J = k;
				break;
			}
		}
		if (label_between) continue;
		const scope_end = J === -1 ? e : J + 1;

		// dX appears NOWHERE outside the cycle (no stray reader keeps a
		// stale register after the deletion).
		let outside = false;
		for (let k = 0; k < parsed.length && !outside; k++) {
			if (k >= h + 1 && k < e) continue;
			const c = parsed[k];
			if (!c) continue;
			if (instr_regs(c).includes(dX)) outside = true;
		}
		if (outside) continue;

		// Fresh caller-saved d-register, textually absent in every form.
		let dM: string | null = null;
		for (let m = 16; m <= 31; m++) {
			if (present(m)) continue;
			dM = `d${m}`;
			break;
		}
		if (!dM) continue;

		// Rename the in-scope READS of dX (def positions keep dX), delete
		// the in-loop materialization, insert once before the header.
		for (let k = i + 1; k < scope_end; k++) {
			const c = parsed[k];
			if (!c) continue;
			lines[k] = rename_reads(lines[k], c, dX, dM);
		}
		lines.splice(i, 1);
		const indent = lines[h].match(/^\s*/)?.[0] ?? "";
		lines.splice(h, 0, `${indent}fmov ${dM}, ${imm.raw}`);
		return lines.join("\n");
	}
	return null;
}

/** Rewrite `line` so every READ occurrence of `from` becomes `to`. The
 *  textual occurrences of a register token map one-to-one onto its reg
 *  operands in order, so the q-th match is the q-th dX operand — rename
 *  it iff that operand sits in a read position. Shared with the sibling
 *  asm-level passes (staging elision). */
export function rename_reads(
	line: string,
	instr: AsmInstruction,
	from: string,
	to: string,
): string {
	const defs = new Set(exact_defs(instr));
	const dx_ops: boolean[] = [];
	for (let p = 0; p < instr.operands.length; p++) {
		const o = instr.operands[p];
		if (o.kind === "reg" && o.name === from) dx_ops.push(p > 0 || !defs.has(from));
	}
	if (!dx_ops.some(Boolean)) return line;
	const re = new RegExp(`\\b${escape_re(from)}\\b`, "g");
	let q = 0;
	return line.replace(re, () => (dx_ops[q++] ? to : from));
}

/**
 * Phase 3 — literal-pool loads in movz/movn range become mov immediates:
 * `ldr xN, =K` → `mov xN, #K`. Defines exactly what the load defined; the
 * range gate is the assembler's encodability.
 */
function remat_int_literals(code: string): string {
	const lines = code.split("\n");
	let changed = false;
	for (let i = 0; i < lines.length; i++) {
		const instr = parse_asm_instruction(lines[i], i + 1);
		if (!instr || instr.op !== "ldr" || instr.operands.length !== 2) continue;
		const [dst, src] = instr.operands;
		if (dst.kind !== "reg" || dst.cls !== "gpr" || dst.name === "sp" || dst.name === "xzr")
			continue;
		if (src.kind !== "imm" || !src.raw.startsWith("=")) continue;
		const k = src.value;
		if (k < -65536n || k > 65535n) continue;
		const indent = lines[i].match(/^\s*/)?.[0] ?? "";
		lines[i] = `${indent}mov ${dst.name}, #${k}`;
		changed = true;
	}
	return changed ? lines.join("\n") : code;
}

/** The tranche entry point: all three rewrites, kill-switchable. */
export function rematerialize_constants(code: string): string {
	if (!remat_on) return code;
	let out = remat_float_pairs(code);
	for (let round = 0; round < 8; round++) {
		const next = hoist_one_fmov(out);
		if (next === null) break;
		out = next;
	}
	return remat_int_literals(out);
}
