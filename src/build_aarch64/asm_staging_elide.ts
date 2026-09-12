/**
 * Stack-staging elision (ASM_PLAN_7 tranche 5). The spectral-norm
 * receipt (cause 7): around every computed index, the emitter staged the
 * receiver through a stack round-trip even though the value already sat
 * in a register —
 *
 *     mov x1, x25              ; stage the register-resident value
 *     str x1, [sp, #-16]!      ; push (keep it alive across the index)
 *     add x0, x13, x24         ; compute the index into x0
 *     ldr x1, [sp], #16        ; pop
 *     add x0, x1, x0           ; consume
 *
 * — three instructions of pure staging per iteration, ×2 paths. When the
 * shape is exact, it elides to `add x0, x25, x0`:
 *
 * - The staging mov makes the preserved value equal xV's value, and xV
 *   is redefined NOWHERE between the mov and the consuming instruction
 *   (linear block: no labels, no branches, no calls, nothing touching
 *   sp or xS, nothing defining xV), so the popped value always equals
 *   the live xV. Renaming the consumer's read of xS to xV is then
 *   exact, and the mov/push/pop triple deletes.
 * - xS's own value AFTER the consumer changes (pre: the staged value;
 *   post: whatever xS held before the mov). Exact liveness over the
 *   rewritten text proves xS dead after the consumer — in both register
 *   views, with the shared call-arg exception (an unwritten ABI arg slot
 *   observes nothing) — so the change is unobservable. Live refuses.
 * - Only the mov-form elides: a bare push/pop whose pushed value came
 *   from elsewhere has no register to rename to, and stays.
 *
 * Runs AFTER constant rematerialization and BEFORE
 * eliminate_dead_cycle_moves. Kill-switch:
 * `set_staging_elide_enabled(false)` returns the text unchanged
 * (byte-identical off arm).
 */

import {
	ALL_TRACKED,
	analyze_function_at,
	exact_defs,
	function_chunk_start,
	transfer,
	type Analysis,
	type Block,
} from "./asm_cycle_dead_moves.ts";
import { instr_regs } from "./asm_if_convert.ts";
import type { AsmInstruction } from "./asm_ir.ts";
import { rename_reads } from "./asm_remat.ts";
import { parse_asm_instruction } from "./lift_asm.ts";

let elide_on = true;

export function staging_elide_enabled(): boolean {
	return elide_on;
}

export function set_staging_elide_enabled(enabled: boolean): void {
	elide_on = enabled;
}

const FORBIDDEN_REGS = new Set(["sp", "xzr", "x29", "x30", "fp", "lr", "wzr"]);
const MAX_MIDDLE = 16;

function is_x_reg(name: string): boolean {
	return /^x\d+$/.test(name) && !FORBIDDEN_REGS.has(name);
}

function is_control_transfer(op: string): boolean {
	return (
		op === "b" ||
		op.startsWith("b.") ||
		op === "bl" ||
		op === "blr" ||
		op === "br" ||
		op === "ret" ||
		op === "cbz" ||
		op === "cbnz" ||
		op === "tbz" ||
		op === "tbnz" ||
		op === "svc"
	);
}

/** The push: `str xS, [sp, #-16]!`. `xS` "*" accepts any x-register. */
function is_push(instr: AsmInstruction, xS: string): boolean {
	if (instr.op !== "str" || instr.operands.length !== 2) return false;
	const [dst, mem] = instr.operands;
	if (dst.kind !== "reg" || (xS !== "*" && dst.name !== xS)) return false;
	if (!is_x_reg(dst.name)) return false;
	if (mem.kind !== "mem" || mem.base !== "sp" || mem.writeback !== "pre") return false;
	return (
		mem.offset?.kind === "imm" &&
		mem.offset.value === -16n &&
		!mem.scale &&
		mem.postOffset === undefined
	);
}

/** The pop: `ldr xS, [sp], #16`. */
function is_pop(instr: AsmInstruction, xS: string): boolean {
	if (instr.op !== "ldr" || instr.operands.length !== 2) return false;
	const [dst, mem] = instr.operands;
	if (dst.kind !== "reg" || dst.name !== xS) return false;
	if (mem.kind !== "mem" || mem.base !== "sp" || mem.writeback !== "post") return false;
	return mem.postOffset === 16n && !mem.offset && !mem.scale;
}

/** One elision candidate: line indexes of the mov, push, pop, consumer. */
interface ElideCandidate {
	mov_idx: number;
	push_idx: number;
	pop_idx: number;
	use_idx: number;
	xS: string;
	xV: string;
}

/** One plain pair candidate (no staging mov — the value may come from a
 *  slot load): the pair is a pure identity, deleted unconditionally. */
interface PairCandidate {
	push_idx: number;
	pop_idx: number;
	xS: string;
}

/** The w/x sibling shares the physical register: a w write rewrites the
 *  x view's low half (the if-conversion pass's discipline). */
function sibling_reg(name: string): string {
	return /^x\d+$/.test(name) ? `w${name.slice(1)}` : `x${name.slice(1)}`;
}

/** The linear middle scan between a push and its pop. Blank/comment/
 *  directive lines ride along. Returns the stop index with `clean` set
 *  when the scan stopped ON the expected pop without touching xS (either
 *  register view), hitting a boundary, or a control transfer —
 *  `clean: false` rejects. */
function scan_middle(
	lines: string[],
	parsed: (AsmInstruction | null)[],
	from: number,
	xS: string,
): { stop: number; clean: boolean } {
	const xS_w = sibling_reg(xS);
	let k = from;
	let middle = 0;
	while (k < parsed.length && middle < MAX_MIDDLE) {
		const t = lines[k].trim();
		const mid = parsed[k];
		if (!mid) {
			if (!t || t.startsWith("//") || t.startsWith(".") || /^[\w.$]+\s*=\s*[\w.$]+$/.test(t)) {
				k++;
				continue;
			}
			return { stop: k, clean: false }; // a label: control-flow boundary
		}
		if (mid.op === "ldr" && is_pop(mid, xS)) return { stop: k, clean: true };
		if (is_control_transfer(mid.op)) return { stop: k, clean: false };
		const regs = instr_regs(mid);
		if (regs.includes("sp") || regs.includes(xS) || regs.includes(xS_w)) {
			return { stop: k, clean: false };
		}
		middle++;
		k++;
	}
	return { stop: k, clean: false };
}

/** Form-B pairs: `str xS, [sp,#-16]!` … clean middle … `ldr xS, [sp],#16`.
 *  The pop restores exactly the pushed value (the middle cannot touch it),
 *  so deleting BOTH lines is a semantic identity — no verdict needed. */
export function find_pairs(lines: string[]): PairCandidate[] {
	const parsed: (AsmInstruction | null)[] = lines.map((l, i) => parse_asm_instruction(l, i + 1));
	const out: PairCandidate[] = [];
	for (let i = 0; i < parsed.length - 2; i++) {
		const push = parsed[i];
		if (!push || !is_push(push, "*")) continue;
		const xS = (push.operands[0] as { kind: "reg"; name: string }).name;
		const { stop, clean } = scan_middle(lines, parsed, i + 1, xS);
		if (!clean) continue;
		out.push({ push_idx: i, pop_idx: stop, xS });
	}
	return out;
}

export function find_candidates(lines: string[]): ElideCandidate[] {
	const parsed: (AsmInstruction | null)[] = lines.map((l, i) => parse_asm_instruction(l, i + 1));
	const out: ElideCandidate[] = [];
	for (let i = 0; i < parsed.length - 4; i++) {
		const mov = parsed[i];
		if (!mov || mov.op !== "mov" || mov.operands.length !== 2) continue;
		const [dst, src] = mov.operands;
		if (dst.kind !== "reg" || src.kind !== "reg") continue;
		if (!is_x_reg(dst.name) || !is_x_reg(src.name) || dst.name === src.name) continue;
		const xS = dst.name;
		const xV = src.name;
		if (!parsed[i + 1] || !is_push(parsed[i + 1]!, xS)) continue;
		// Middle: clean linear region between the push and the pop, and no
		// xV definition inside it (w-siblings share the register).
		const { stop, clean } = scan_middle(lines, parsed, i + 2, xS);
		if (!clean || stop <= i + 2) continue;
		const xV_w = sibling_reg(xV);
		let defines_xv = false;
		for (let m = i + 2; m < stop && !defines_xv; m++) {
			const mid = parsed[m];
			if (!mid) continue;
			const defs = exact_defs(mid);
			if (defs.includes(xV) || defs.includes(xV_w)) defines_xv = true;
		}
		if (defines_xv) continue;
		const pop = parsed[stop];
		if (!pop || !is_pop(pop, xS)) continue;
		const use = parsed[stop + 1];
		if (!use || is_control_transfer(use.op)) continue;
		// The consumer must READ xS (the staged value) — def positions stay.
		const defs = new Set(exact_defs(use));
		let reads_xs = false;
		for (let p = 0; p < use.operands.length; p++) {
			const o = use.operands[p];
			if (o.kind === "reg" && o.name === xS && (p > 0 || !defs.has(xS))) reads_xs = true;
		}
		if (!reads_xs) continue;
		// xV must survive to the consumer: nothing between the mov and the
		// use may define it (the middle was checked above; the pop defines
		// only xS; reading the old xV in the consumer is fine since xV was
		// never redefined — but redefining it there would strand the read).
		const use_defs = exact_defs(use);
		if (use_defs.includes(xV) || use_defs.includes(xV_w)) continue;
		out.push({ mov_idx: i, push_idx: i + 1, pop_idx: stop, use_idx: stop + 1, xS, xV });
	}
	return out;
}

/** Exact liveness (backward fixpoint, call-arg slots for the tracked
 *  registers excluded) — is `reg` dead after instruction index `f`? */
function reg_dead_after(a: Analysis, f: number, reg: string): boolean {
	const exclude = new Set([reg]);
	const step = (instr: AsmInstruction, live: Set<string>): void => {
		if (instr.op === "ret") {
			// The return pair x0/x1/d0/d1 is read only when the function
			// actually returns in it — an unwritten half is garbage the
			// caller cannot observe. The tracked register is exactly such
			// a slot here (it was staging, not return data).
			live.clear();
			for (const r of ["x0", "x1", "d0", "d1"]) {
				if (r !== reg) live.add(r);
			}
			return;
		}
		if (instr.op === "svc") {
			for (let x = 0; x <= 17; x++) {
				if (`x${x}` !== reg) live.add(`x${x}`);
			}
			return;
		}
		if (instr.op === "bl" || instr.op === "blr") {
			for (let x = 0; x <= 17; x++) live.delete(`x${x}`);
			live.delete("x30");
			for (let d = 0; d <= 7; d++) live.delete(`d${d}`);
			for (let x = 0; x <= 8; x++) {
				if (!exclude.has(`x${x}`)) live.add(`x${x}`);
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
			const blk: Block = a.blocks[bi];
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
	if (blk < 0) return false;
	const live = new Set<string>();
	for (const s of a.blocks[blk].succ) {
		for (const r of live_in[s]) live.add(r);
	}
	// Walk strictly BELOW f: the result is live-before(f+1) = live-after(f).
	// The consumer's own def of xS (def positions are never renamed) must
	// not mask later readers.
	for (let k = a.blocks[blk].end; k > f; k--) {
		if (a.kind[k] !== "instr") continue;
		if (a.parsed[k]) step(a.parsed[k]!, live);
		else for (const r of ALL_TRACKED) live.add(r);
	}
	return !live.has(reg) && !live.has(`w${reg.slice(1)}`);
}

/** Rebuild `lines` with the winners elided in ONE pass (the indexes are
 *  original-text line numbers). Winners whose consumer line another
 *  winner deletes are skipped by the caller's one-per-xS + disjointness
 *  filter. */
function apply_winners(
	lines: string[],
	parsed: (AsmInstruction | null)[],
	winners: ElideCandidate[],
): string[] {
	const drop = new Set<number>();
	const rename_at = new Map<number, { instr: AsmInstruction; xS: string; xV: string }>();
	for (const c of winners) {
		drop.add(c.mov_idx);
		drop.add(c.push_idx);
		drop.add(c.pop_idx);
		rename_at.set(c.use_idx, { instr: parsed[c.use_idx]!, xS: c.xS, xV: c.xV });
	}
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (drop.has(i)) continue;
		const r = rename_at.get(i);
		out.push(r ? rename_reads(lines[i], r.instr, r.xS, r.xV) : lines[i]);
	}
	return out;
}

/**
 * Phase entry — elide every provable staging round-trip. Form A (with the
 * staging mov: triple delete + consumer rename) is verdict-gated; form B
 * (bare pair around a clean middle) is a semantic identity and deletes
 * unconditionally. One settle-round per staging register.
 */
export function elide_stack_staging(code: string): string {
	if (!elide_on) return code;
	// Form A: mov + pair + consumer, verdict-gated.
	for (let round = 0; round < 16; round++) {
		const lines = code.split("\n");
		const parsed = lines.map((l, i) => parse_asm_instruction(l, i + 1));
		const cands = find_candidates(lines);
		if (cands.length === 0) break;
		// Select the round's set first: one candidate per staging register,
		// disjoint spans. Spans are inherently disjoint (a nested pair
		// breaks the enclosing middle scan at its push); two candidates on
		// one xS never share a round — their verdicts would otherwise see
		// each other's transforms (a same-register pop def / consumer read
		// vanishing only in the trial).
		const selected: ElideCandidate[] = [];
		const seen_xs = new Set<string>();
		for (const c of cands) {
			if (seen_xs.has(c.xS)) continue;
			selected.push(c);
			seen_xs.add(c.xS);
		}
		// ONE combined trial; each verdict analyzes ONLY its own function
		// chunk (control flow cannot cross a ret, so the per-function
		// result is exact). A sibling candidate's rename can only ADD reads
		// of this one's xV — a conservative direction (refused here,
		// retried next round after the sibling lands).
		const combined = apply_winners(lines, parsed, selected);
		const combined_code = combined.join("\n");
		const chunk_memo = new Map<number, { a: Analysis; offset: number } | null>();
		const winners: ElideCandidate[] = [];
		for (const c of selected) {
			// The trial deleted this candidate's own mov/push/pop (all above
			// its consumer) plus every other selected candidate's lines
			// below it.
			let f = c.use_idx - 3;
			for (const d of selected) {
				if (d === c) continue;
				if (d.mov_idx < c.use_idx) f--;
				if (d.push_idx < c.use_idx) f--;
				if (d.pop_idx < c.use_idx) f--;
			}
			const chunk = function_chunk_start(combined, f);
			let entry = chunk_memo.get(chunk);
			if (entry === undefined) {
				entry = analyze_function_at(combined_code, f);
				chunk_memo.set(chunk, entry);
			}
			if (!entry) continue;
			if (reg_dead_after(entry.a, f - entry.offset, c.xS)) winners.push(c);
		}
		if (winners.length === 0) break;
		code = apply_winners(lines, parsed, winners).join("\n");
	}
	// Form B: bare pairs — a pure identity, delete to fixpoint.
	for (let round = 0; round < 16; round++) {
		const lines = code.split("\n");
		const pairs = find_pairs(lines);
		if (pairs.length === 0) break;
		const drop = new Set<number>();
		for (const p of pairs) {
			drop.add(p.push_idx);
			drop.add(p.pop_idx);
		}
		code = lines.filter((_, i) => !drop.has(i)).join("\n");
	}
	return code;
}
