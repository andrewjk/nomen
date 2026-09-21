/**
 * Dead staging-move elimination inside validated loop cycles
 * (ASM_PLAN_6 tranche 4: the D4-multiply staging movs).
 *
 * The per-statement emission model stages operands into fixed protocol
 * registers (`mov x2, x23` before a compare, `mov x1, x27` before a
 * multiply) even when the consumer instruction reads the SOURCE register
 * directly. The copy coalescer substitutes read operands and flags the
 * moves it rewrote, but a move whose consumer never read the destination
 * in the first place is never flagged — and the function-wide dead-move
 * pass ships default-OFF (measured −1.3…−1.5% on nbody: global layout
 * perturbation). Inside a hot loop the leftovers execute every iteration:
 * the D4-multiply cycle alone carried five (`mov x2, x23`, `mov x1, x27`,
 * `mov x0, x19`, `mov x2, x12`, `mov x11, x9`).
 *
 * This pass deletes a reg-reg `mov xD, xS` whose destination is provably
 * dead — but ONLY inside validated cycles (the promote_loop_slots model:
 * [label … `b label`] with no inner label of either spelling, no
 * bl/blr/br/svc/ret), bounding the blast radius to the loops that pay
 * iteration rent. Liveness is EXACT here, not the two-set taint
 * approximation: a function-level CFG (blocks, resolved-branch +
 * fall-through edges, ret exits) with a backward fixpoint, so a value
 * that escapes through a loop exit (the si2 base read just after
 * .end_while_22) keeps its defining move while a guard's compare staging
 * dies.
 *
 * Soundness model:
 * - Blocks break at labels and at b/b.cond/cbz/cbnz/tbz/tbnz/ret; edges
 *   are fall-through plus resolved targets (the numeric `1f`/`1b` forms
 *   raw `#arch` blocks use included). `br` (indirect) or an unresolvable
 *   target aborts the pass — the text is returned unchanged.
 * - `bl`/`blr` read the argument registers (x0–x8, d0–d7) and define the
 *   caller-saved set (x0–x17, x30, d0–d7); `svc` reads x0–x17; `ret`
 *   ends flow, reading the return pair (x0/x1, d0/d1).
 * - defs/reads are the positional dest-first models the coalescer uses
 *   (str/stp/cmp define nothing; memory base/index are reads; a
 *   def-and-source operand counts as a read of the OLD value). A w-def
 *   killing only its own name is conservative: an x-sibling read keeps
 *   the earlier x-def alive (missed deletion, never a wrong one).
 * - Cycles: header provenance from inside, exits are conditional branches
 *   (allowed — the exact CFG prices them), deletions strictly between
 *   the header and the back-edge.
 * - Deletion iterates to a fixpoint (a deleted move's source read can
 *   kill a chained move in the next round).
 *
 * Runs AFTER coalesce_copies (the final consumer shapes are what get
 * priced). Kill-switch: `set_cycle_dead_moves_enabled(false)` returns the
 * text unchanged.
 */

import type { AsmInstruction } from "./asm_ir.ts";
import { parse_asm_instruction } from "./lift_asm.ts";

let cycle_dead_moves_on = true;

export function cycle_dead_moves_enabled(): boolean {
	return cycle_dead_moves_on;
}

export function set_cycle_dead_moves_enabled(enabled: boolean): void {
	cycle_dead_moves_on = enabled;
}

const LABEL_LINE_RE = /^([A-Za-z_.$][\w.$]*|\d+):$/;
const B_ALIAS_RE = /^(eq|ne|lt|le|gt|ge|hs|lo|ls|hi|mi|pl)$/;
const NUM_TARGET_RE = /^(\d+)([fb])$/;

export const ALL_TRACKED: string[] = [];
for (let r = 0; r <= 30; r++) ALL_TRACKED.push(`x${r}`, `w${r}`, `d${r}`);
ALL_TRACKED.push("sp", "xzr");

function is_branch_op(op: string): boolean {
	if (op === "b" || op === "cbz" || op === "cbnz" || op === "tbz" || op === "tbnz") return true;
	if (op === "bl" || op === "blr" || op === "br" || op === "ret") return false;
	if (op.startsWith("b.")) return true;
	return op[0] === "b" && op.length > 1 && B_ALIAS_RE.test(op.slice(1));
}

/** Registers an instruction WRITES (exact, dest-first) — the coalescer's
 *  model. Shared with the sibling asm-level passes (remat). */
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
	if (instr.op.startsWith("b")) return [];
	for (const o of instr.operands) {
		if (o.kind === "reg") return [o.name];
		if (o.kind === "mem" || o.kind === "cond" || o.kind === "imm" || o.kind === "label") break;
	}
	return [];
}

/** Registers an instruction READS: every register operand outside the
 *  leading def positions, plus memory base/index (the coalescer's
 *  positional model). Shared with the sibling asm-level passes (remat). */
export function reads_of(instr: AsmInstruction): string[] {
	let skip: number;
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
		case "blr":
		case "br":
		case "cbz":
		case "cbnz":
		case "tbz":
		case "tbnz":
			skip = 0;
			break;
		case "ldp":
			skip = 2;
			break;
		default:
			skip = 1;
			break;
	}
	const out: string[] = [];
	let reg_seen = 0;
	for (const o of instr.operands) {
		if (o.kind === "reg") {
			if (reg_seen++ >= skip) out.push(o.name);
		} else if (o.kind === "mem") {
			out.push(o.base);
			if (o.offset?.kind === "reg") out.push(o.offset.name);
		}
	}
	return out;
}

/** The pruning candidate: `mov xD, xS`, x-family, fp/lr/sp excluded. */
function mov_dest(instr: AsmInstruction): string | null {
	if (instr.op !== "mov" || instr.operands.length !== 2) return null;
	const d = instr.operands[0];
	const s = instr.operands[1];
	if (d.kind !== "reg" || s.kind !== "reg") return null;
	if (!/^x\d+$/.test(d.name) || !/^x\d+$/.test(s.name)) return null;
	if (d.name === s.name || d.name === "x29" || d.name === "x30") return null;
	return d.name;
}

/** Per-instruction liveness transfer — shared with the sibling asm-level
 *  passes (remat). */
export function transfer(instr: AsmInstruction, live: Set<string>): void {
	const op = instr.op;
	if (op === "bl" || op === "blr") {
		for (let a = 0; a <= 17; a++) live.delete(`x${a}`);
		live.delete("x30");
		for (let d = 0; d <= 7; d++) live.delete(`d${d}`);
		for (let a = 0; a <= 8; a++) {
			live.add(`x${a}`);
			live.add(`d${a}`);
		}
		return;
	}
	if (op === "svc") {
		for (let a = 0; a <= 17; a++) live.add(`x${a}`);
		return;
	}
	if (op === "ret") {
		live.clear();
		live.add("x0");
		live.add("x1");
		live.add("d0");
		live.add("d1");
		return;
	}
	for (const d of exact_defs(instr)) live.delete(d);
	for (const r of reads_of(instr)) live.add(r);
}

export interface Analysis {
	lines: string[];
	parsed: (AsmInstruction | null)[];
	kind: ("label" | "instr" | "skip")[];
	blocks: Block[];
	line_block: number[];
	live_in: Set<string>[];
	cycles: { head: number; end: number }[];
}

export interface Block {
	start: number;
	end: number;
	succ: number[];
}

/** The full CFG analysis shared with the sibling asm-level passes (remat):
 *  blocks, resolved edges, and exact backward liveness. Null = the text
 *  contains something the model does not handle. */
export function analyze_cfg(code: string): Analysis | null {
	return analyze(code);
}

/** The start line of the function chunk containing `idx` — the same
 *  boundary heuristic the lift uses (a non-blank preceding `ret`, `.data`,
 *  `.p2align`, or `.text` line opens a new chunk). Liveness cannot flow
 *  across a `ret`, so per-chunk analysis is exact. */
export function function_chunk_start(lines: string[], idx: number): number {
	let start = 0;
	let prev = "";
	for (let i = 0; i < idx; i++) {
		const t = lines[i].trim();
		if (!t) continue;
		if (
			prev === "ret" ||
			prev.startsWith(".data") ||
			prev.startsWith(".p2align") ||
			prev.startsWith(".text")
		) {
			start = i;
		}
		prev = t;
	}
	return start;
}

/** Analyze ONLY the function chunk containing `line_idx` — the same
 *  blocks/edges/liveness as a whole-text analysis restricted to that
 *  function (control flow cannot cross a `ret`), at a fraction of the
 *  cost on multi-function program text. `offset` maps chunk-relative
 *  line indexes back to whole-text indexes. */
export function analyze_function_at(
	code: string,
	line_idx: number,
): { a: Analysis; offset: number } | null {
	const lines = code.split("\n");
	const start = function_chunk_start(lines, line_idx);
	let end = lines.length;
	let prev = "";
	for (let i = start; i < lines.length; i++) {
		const t = lines[i].trim();
		if (!t) continue;
		if (
			i > start &&
			(prev === "ret" ||
				prev.startsWith(".data") ||
				prev.startsWith(".p2align") ||
				prev.startsWith(".text"))
		) {
			end = i;
			break;
		}
		prev = t;
	}
	const a = analyze(lines.slice(start, end).join("\n"));
	if (!a) return null;
	return { a, offset: start };
}

/** One full analysis pass over the text; null = abort (the text contains
 *  something the CFG does not model — the caller returns it unchanged). */
function analyze(code: string): Analysis | null {
	const lines = code.split("\n");
	const n = lines.length;
	const parsed: (AsmInstruction | null)[] = Array.from({ length: n }, () => null);
	const kind: ("label" | "instr" | "skip")[] = Array.from({ length: n }, () => "skip" as const);
	const labels = new Map<string, number[]>();
	const unknown = new Set<number>();
	const raw_jumps: { from: number; token: string; cond: boolean }[] = [];

	for (let i = 0; i < n; i++) {
		const t = lines[i].trim();
		const lm = LABEL_LINE_RE.exec(t);
		if (lm) {
			kind[i] = "label";
			const ps = labels.get(lm[1]);
			if (ps) ps.push(i);
			else labels.set(lm[1], [i]);
			continue;
		}
		if (!t || t.startsWith("//") || t.startsWith(".") || /^[\w.$]+\s*=\s*[\w.$]+$/.test(t)) {
			kind[i] = "skip";
			continue;
		}
		const instr = parse_asm_instruction(lines[i], i + 1);
		if (!instr) {
			kind[i] = "instr";
			unknown.add(i);
			continue;
		}
		kind[i] = "instr";
		parsed[i] = instr;
		if (instr.op === "br") return null;
		if (is_branch_op(instr.op)) {
			const target = instr.operands.find((o) => o.kind === "label");
			if (!target || target.kind !== "label") return null;
			raw_jumps.push({ from: i, token: (target as { name: string }).name, cond: instr.op !== "b" });
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

	const jumps: { from: number; target: number; cond: boolean }[] = [];
	for (const rj of raw_jumps) {
		const pos = resolve_target(rj.token, rj.from);
		if (pos === null) return null;
		jumps.push({ from: rj.from, target: pos, cond: rj.cond });
	}

	// Blocks: start at labels (or the first instruction after control
	// flow), end at branch/ret.
	const blocks: Block[] = [];
	const line_block: number[] = Array.from({ length: n }, () => -1);
	const label_block = new Map<number, number>();
	let cur: Block | null = null;
	let pending_labels: number[] = [];
	for (let i = 0; i < n; i++) {
		if (kind[i] === "label") {
			pending_labels.push(i);
			cur = null;
			continue;
		}
		if (kind[i] !== "instr") continue;
		const instr = parsed[i];
		const term = instr !== null && (is_branch_op(instr.op) || instr.op === "ret");
		if (!cur) {
			const start = pending_labels.length > 0 ? pending_labels[0] : i;
			// Fall-through edge: the previous block ended at a
			// non-terminator (this block opened on a label boundary).
			if (blocks.length > 0) {
				const prev = blocks[blocks.length - 1];
				const pe = parsed[prev.end];
				const prev_term = pe ? is_branch_op(pe.op) || pe.op === "ret" : false;
				if (!prev_term) prev.succ.push(blocks.length);
			}
			cur = { start, end: i, succ: [] };
			blocks.push(cur);
			for (const pl of pending_labels) {
				label_block.set(pl, blocks.length - 1);
				line_block[pl] = blocks.length - 1;
			}
			pending_labels = [];
		}
		cur.end = i;
		line_block[i] = blocks.length - 1;
		if (term) cur = null;
	}

	for (const blk of blocks) {
		const end_instr = parsed[blk.end];
		if (!end_instr) continue;
		if (end_instr.op === "ret") continue;
		if (!is_branch_op(end_instr.op)) continue;
		if (end_instr.op === "b") {
			const target = end_instr.operands.find((o) => o.kind === "label");
			const pos = resolve_target((target as { name: string }).name, blk.end);
			const tb = pos === null ? undefined : label_block.get(pos);
			if (tb === undefined) return null;
			blk.succ.push(tb);
		} else {
			const target = end_instr.operands.find((o) => o.kind === "label");
			const pos = resolve_target((target as { name: string }).name, blk.end);
			const tb = pos === null ? undefined : label_block.get(pos);
			if (tb === undefined) return null;
			blk.succ.push(tb);
			if (line_block[blk.end] + 1 >= blocks.length) return null;
			blk.succ.push(line_block[blk.end] + 1);
		}
	}

	// Validated cycles: [head label … unconditional back-edge], no inner
	// label of either spelling, no bl/blr/br/svc/ret, header provenance
	// from inside.
	const cycles: { head: number; end: number }[] = [];
	for (const [, ps] of labels) {
		for (const head of ps) {
			for (const j of jumps) {
				if (j.target !== head || j.cond || j.from <= head) continue;
				const end = j.from;
				let ok = true;
				for (let k = head + 1; k < end && ok; k++) {
					if (kind[k] === "label") {
						// Fall-through markers (`.while_update_N:`) ride inside
						// the cycle; a label any jump TARGETS breaks it.
						if (jumps.some((j3) => j3.target === k)) ok = false;
					} else if (parsed[k]) {
						const op = parsed[k]!.op;
						if (op === "bl" || op === "blr" || op === "br" || op === "svc" || op === "ret") {
							ok = false;
						}
					} else if (unknown.has(k)) {
						ok = false;
					}
				}
				if (ok) {
					for (const j2 of jumps) {
						if (j2.target === head && !(j2.from > head && j2.from <= end)) {
							ok = false;
							break;
						}
					}
				}
				if (ok) cycles.push({ head, end });
			}
		}
	}

	// Backward liveness fixpoint.
	const live_in: Set<string>[] = blocks.map(() => new Set<string>());
	let changed = true;
	while (changed) {
		changed = false;
		for (let bi = blocks.length - 1; bi >= 0; bi--) {
			const blk = blocks[bi];
			const live = new Set<string>();
			for (const s of blk.succ) {
				for (const r of live_in[s]) live.add(r);
			}
			for (let i = blk.end; i >= blk.start; i--) {
				if (kind[i] !== "instr") continue;
				if (parsed[i]) transfer(parsed[i]!, live);
				else for (const r of ALL_TRACKED) live.add(r);
			}
			if (live.size !== live_in[bi].size || [...live].some((r) => !live_in[bi].has(r))) {
				live_in[bi] = live;
				changed = true;
			}
		}
	}

	return { lines, parsed, kind, blocks, line_block, live_in, cycles };
}

export function eliminate_dead_cycle_moves(code: string): string {
	if (!cycle_dead_moves_on) return code;
	for (let round = 0; round < 4; round++) {
		const a = analyze(code);
		if (!a) return code;
		const in_cycle: boolean[] = Array.from({ length: a.lines.length }, () => false);
		for (const { head, end } of a.cycles) {
			for (let i = head + 1; i < end; i++) in_cycle[i] = true;
		}
		const out = a.lines.slice();
		let deleted = 0;
		for (let bi = 0; bi < a.blocks.length; bi++) {
			const blk = a.blocks[bi];
			const live = new Set<string>();
			for (const s of blk.succ) {
				for (const r of a.live_in[s]) live.add(r);
			}
			for (let i = blk.end; i >= blk.start; i--) {
				if (a.kind[i] !== "instr") continue;
				const instr = a.parsed[i];
				if (!instr) {
					for (const r of ALL_TRACKED) live.add(r);
					continue;
				}
				if (in_cycle[i]) {
					const dst = mov_dest(instr);
					// The w-sibling shares the def's fate: a `str w2` below
					// consumes the x2 def's low half, so the mov is only
					// dead when NEITHER view is read (the buffer_uint32
					// receipt).
					if (dst !== null && !live.has(dst) && !live.has(`w${dst.slice(1)}`)) {
						out[i] = "";
						deleted++;
						continue;
					}
				}
				transfer(instr, live);
			}
		}
		if (deleted === 0) return code;
		code = out.join("\n");
	}
	return code;
}
