/**
 * Dead staging-mv elimination inside validated loop cycles
 * (ASM_PLAN_6 tranche 4: the D4-multiply staging movs).
 *
 * The per-statement emission model stages operands into fixed protocol
 * registers (`mov x2, x23` before a compare, `mov x1, x27` before a
 * multiply) even when the consumer instruction reads the SOURCE register
 * directly. The copy coalescer substitutes read operands and flags the
 * moves it rewrote, but a mv whose consumer never read the destination
 * in the first place is never flagged — and the function-wide dead-mv
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
 * .end_while_22) keeps its defining mv while a guard's compare staging
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
 * - Deletion iterates to a fixpoint (a deleted mv's source read can
 *   kill a chained mv in the next round).
 *
 * Runs AFTER coalesce_copies (the final consumer shapes are what get
 * priced). Kill-switch: `set_cycle_dead_moves_enabled(false)` returns the
 * text unchanged.
 */

import type { AsmInstruction } from "./asm_ir.ts";
import { is_alias_line } from "./asm_ir.ts";
import {
	ALL_MASK,
	compute_live_in,
	MASK_WORDS,
	mask_or,
	type RegMask,
	transfer_mask,
	xw_live,
} from "./asm_liveness.ts";
import { parse_asm_instruction_shared } from "./lift_asm.ts";

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

function is_branch_op(op: string): boolean {
	if (op === "b" || op === "cbz" || op === "cbnz" || op === "tbz" || op === "tbnz") return true;
	if (op === "bl" || op === "blr" || op === "br" || op === "ret") return false;
	if (op.startsWith("b.")) return true;
	return op[0] === "b" && op.length > 1 && B_ALIAS_RE.test(op.slice(1));
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

export interface Analysis {
	lines: string[];
	parsed: (AsmInstruction | null)[];
	kind: ("label" | "instr" | "skip")[];
	blocks: Block[];
	line_block: number[];
	/** Backward liveness fixpoint over the register-universe masks
	 *  (asm_liveness.ts) — the string-Set model's exact replacement. */
	live_in: RegMask[];
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
		if (!t || t.startsWith("//") || t.startsWith(".") || is_alias_line(t)) {
			kind[i] = "skip";
			continue;
		}
		const instr = parse_asm_instruction_shared(lines[i], i + 1);
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

	// Backward liveness fixpoint (mask-based — asm_liveness.ts).
	const live_in = compute_live_in({ blocks, parsed, kind });

	return { lines, parsed, kind, blocks, line_block, live_in, cycles };
}

export function eliminate_dead_cycle_moves(code: string): string {
	if (!cycle_dead_moves_on) return code;
	// Function chunks, split ONCE. Control flow cannot cross a `ret`, so
	// each chunk is analyzed and iterated to its own fixpoint independently
	// — the old driver re-analyzed the ENTIRE program per round (whole-text
	// split + parse + CFG + liveness × up to 4 rounds) even when only one
	// function still had candidates.
	const lines = code.split("\n");
	const starts: number[] = [0];
	{
		let prev = "";
		for (let i = 0; i < lines.length; i++) {
			const t = lines[i].trim();
			if (!t) continue;
			if (
				i > 0 &&
				(prev === "ret" ||
					prev.startsWith(".data") ||
					prev.startsWith(".p2align") ||
					prev.startsWith(".text"))
			) {
				starts.push(i);
			}
			prev = t;
		}
	}
	let any_change = false;
	for (let c = 0; c < starts.length; c++) {
		const start = starts[c];
		const end = c + 1 < starts.length ? starts[c + 1] : lines.length;
		let chunk_text = lines.slice(start, end).join("\n");
		let chunk_changed = false;
		for (let round = 0; round < 4; round++) {
			const a = analyze(chunk_text);
			if (!a) break;
			const in_cycle: boolean[] = Array.from({ length: a.lines.length }, () => false);
			for (const { head, end: cyc_end } of a.cycles) {
				for (let i = head + 1; i < cyc_end; i++) in_cycle[i] = true;
			}
			const out = a.lines.slice();
			let deleted = 0;
			const live: RegMask = new Uint32Array(MASK_WORDS);
			for (let bi = 0; bi < a.blocks.length; bi++) {
				const blk = a.blocks[bi];
				live[0] = 0;
				live[1] = 0;
				live[2] = 0;
				for (const s of blk.succ) {
					const li = a.live_in[s];
					live[0] |= li[0];
					live[1] |= li[1];
					live[2] |= li[2];
				}
				for (let i = blk.end; i >= blk.start; i--) {
					if (a.kind[i] !== "instr") continue;
					const instr = a.parsed[i];
					if (!instr) {
						mask_or(live, ALL_MASK);
						continue;
					}
					if (in_cycle[i]) {
						const dst = mov_dest(instr);
						// The w-sibling shares the def's fate: a `str w2` below
						// consumes the x2 def's low half, so the mov is only
						// dead when NEITHER view is read (the buffer_uint32
						// receipt).
						if (dst !== null && !xw_live(live, dst)) {
							out[i] = "";
							deleted++;
							continue;
						}
					}
					transfer_mask(instr, live);
				}
			}
			if (deleted === 0) break;
			chunk_text = out.join("\n");
			chunk_changed = true;
		}
		if (chunk_changed) {
			const new_lines = chunk_text.split("\n");
			// Deletions blank lines in place — the chunk line count is
			// stable, but stay defensive against a shorter/longer chunk.
			for (let i = 0; i < end - start && i < new_lines.length; i++) {
				lines[start + i] = new_lines[i];
			}
			any_change = true;
		}
	}
	return any_change ? lines.join("\n") : code;
}
