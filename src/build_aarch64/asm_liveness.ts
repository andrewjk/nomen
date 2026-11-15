/**
 * Register-universe bitmask liveness for the shared asm-level CFG passes
 * (COMPILER_PERF tranche 1 — the FOLLOWUP.md "string-set liveness" item).
 *
 * The backward fixpoints (asm_cycle_dead_moves' analyze +
 * eliminate_dead_cycle_moves walk, asm_remat's live_before_fmov,
 * asm_staging_elide's reg_dead_after) carried `Set<string>` register names
 * with a fresh Set per block per fixpoint sweep and an
 * iterator-allocating equality probe — the constant factor of the whole
 * post-processing pipeline. Here liveness is a 96-bit register-universe
 * mask in three BigInt-free `Uint32Array` words:
 *
 *   word 0: x0–x30, sp      word 1: w0–w30, xzr      word 2: d0–d31
 *
 * `exact_defs`/`reads_of` still compute per instruction, but their masks
 * are memoized on the (shared, memoized-parse) instruction object, and the
 * `bl`/`blr`/`svc`/`ret` effects are precomputed fixed masks carrying the
 * same call-ABI model the old `transfer` priced:
 *
 * - `bl`/`blr` kill x0–x17, x30, d0–d7 and read x0–x8 + d0–d8.
 * - `svc` reads x0–x17.
 * - `ret` ends flow, reading the return pair (x0/x1, d0/d1).
 *
 * An optional exclusion mask refines the READ adds (remat's unwritten
 * ABI-arg-slot rule applies it to `bl`/`blr` only; staging-elide's
 * staging-slot rule applies it to `svc`/`ret` too) — the same refinement
 * the old per-pass `step` wrappers spelled out by hand.
 *
 * Names outside the universe (`fp`/`lr` aliases, `s0`/`q0`/`v0.2d` family
 * spellings, Mach-O GOT suffix tokens riding mem offsets) drop out of the
 * mask exactly as they behaved as string keys before: nothing ever defines
 * them and no consumer query ever tests them (every query targets an
 * x-family name or its w sibling), so the fixpoint is identical — the same
 * least-fixpoint over the same transfer function, at a fraction of the
 * constant cost.
 */

import type { AsmInstruction } from "./asm_ir.ts";

/** Mask words: 32 bits each — x-regs+sp | w-regs+xzr | d-regs. */
export const MASK_WORDS = 3;

export type RegMask = Uint32Array;

/** All tracked registers, string form — the unknown-instruction fallback's
 *  universe (d0–d30: d31 was never in the string model's list either). */
const ALL_TRACKED: string[] = [];
for (let r = 0; r <= 30; r++) ALL_TRACKED.push(`x${r}`, `w${r}`, `d${r}`);
ALL_TRACKED.push("sp", "xzr");

/** The unknown-instruction fallback's mask — everything ALL_TRACKED names. */
export const ALL_MASK = mask_from_names(ALL_TRACKED);

/** Digits-only parse of the register's number part, capped — the guard
 *  keeps `x`-alone, `x1x2`, and out-of-range spellings out of the universe. */
function reg_number(name: string, max: number): number {
	let n = -1;
	for (let k = 1; k < name.length; k++) {
		const d = name.charCodeAt(k) - 48;
		if (d < 0 || d > 9) return -1;
		n = n < 0 ? d : n * 10 + d;
		if (n > max) return -1;
	}
	return n;
}

/** Bit index of a tracked register name, -1 for anything outside the
 *  universe. NOTE: `fp`/`lr` are parser-accepted aliases of x29/x30 but
 *  were independent string keys in the Set model (nothing defines or tests
 *  them) — they stay outside the universe for identical results. */
export function reg_bit(name: string): number {
	if (name === "xzr") return 63;
	if (name === "sp") return 31;
	switch (name.charCodeAt(0)) {
		case 120: // x
			return name.length > 1 ? reg_number(name, 30) : -1;
		case 119: // w
			return name.length > 1 ? 32 + reg_number(name, 30) : -1;
		case 100: // d
			return name.length > 1 ? 64 + reg_number(name, 31) : -1;
		default:
			// fp/lr/s0…/q0…/v0.2d/GOT-suffix tokens: outside the universe
			return -1;
	}
}

export function new_mask(): RegMask {
	return new Uint32Array(MASK_WORDS);
}

export function mask_from_names(names: string[]): RegMask {
	const m = new Uint32Array(MASK_WORDS);
	for (const n of names) {
		const b = reg_bit(n);
		if (b >= 0) m[b >>> 5] |= 1 << (b & 31);
	}
	return m;
}

export function mask_or(dst: RegMask, src: RegMask): void {
	dst[0] |= src[0];
	dst[1] |= src[1];
	dst[2] |= src[2];
}

export function mask_andnot(dst: RegMask, src: RegMask): void {
	dst[0] &= ~src[0];
	dst[1] &= ~src[1];
	dst[2] &= ~src[2];
}

/** The x/w sibling query every consumer makes — the string model's
 *  `live.has(xR) || live.has("w" + xR.slice(1))`. */
export function xw_live(m: RegMask, xname: string): boolean {
	const b = reg_bit(xname);
	if (b < 0 || b > 30) return false;
	const w = b + 32;
	return ((m[b >>> 5] >>> (b & 31)) & 1) !== 0 || ((m[w >>> 5] >>> (w & 31)) & 1) !== 0;
}

/** Registers an instruction WRITES (exact, dest-first) — the coalescer's
 *  model. Shared with the sibling asm-level passes (fold64, remat). */
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
 *  positional model). Shared with the sibling asm-level passes (fold64,
 *  remat). */
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

// Fixed call/ABI masks — transfer's model, precomputed once.
const BL_KILL = mask_from_names([
	...Array.from({ length: 18 }, (_, i) => `x${i}`),
	"x30",
	...Array.from({ length: 8 }, (_, i) => `d${i}`),
]);
const BL_ARG = mask_from_names([
	...Array.from({ length: 9 }, (_, i) => `x${i}`),
	...Array.from({ length: 9 }, (_, i) => `d${i}`),
]);
const SVC_READ = mask_from_names(Array.from({ length: 18 }, (_, i) => `x${i}`));
const RET_LIVE = mask_from_names(["x0", "x1", "d0", "d1"]);

// Per-instruction def/read masks, memoized on the instruction object. The
// fixpoints revisit the same shared (memoized-parse) instructions on every
// sweep of every round, so each entry pays once per unique text.
const defs_memo = new WeakMap<AsmInstruction, RegMask>();
const reads_memo = new WeakMap<AsmInstruction, RegMask>();

export function defs_mask(instr: AsmInstruction): RegMask {
	let m = defs_memo.get(instr);
	if (m === undefined) {
		m = mask_from_names(exact_defs(instr));
		defs_memo.set(instr, m);
	}
	return m;
}

export function reads_mask(instr: AsmInstruction): RegMask {
	let m = reads_memo.get(instr);
	if (m === undefined) {
		m = mask_from_names(reads_of(instr));
		reads_memo.set(instr, m);
	}
	return m;
}

/** Per-instruction liveness transfer over masks — the string `transfer`
 *  the fixpoints ran, with the read-adds refinable by an exclusion mask
 *  (`exclude_args`: remat's unwritten-bl-arg-slot rule; `exclude_reads`:
 *  staging-elide's staging-slot rule, which also gates `svc`/`ret`). */
export function transfer_mask(
	instr: AsmInstruction,
	live: RegMask,
	exclude_args?: RegMask,
	exclude_reads?: RegMask,
): void {
	const op = instr.op;
	if (op === "bl" || op === "blr") {
		mask_andnot(live, BL_KILL);
		if (exclude_args) {
			live[0] |= BL_ARG[0] & ~exclude_args[0];
			live[1] |= BL_ARG[1] & ~exclude_args[1];
			live[2] |= BL_ARG[2] & ~exclude_args[2];
		} else {
			mask_or(live, BL_ARG);
		}
		return;
	}
	if (op === "svc") {
		if (exclude_reads) {
			live[0] |= SVC_READ[0] & ~exclude_reads[0];
			live[1] |= SVC_READ[1] & ~exclude_reads[1];
			live[2] |= SVC_READ[2] & ~exclude_reads[2];
		} else {
			mask_or(live, SVC_READ);
		}
		return;
	}
	if (op === "ret") {
		// ret ends flow: live becomes exactly the return pair (minus any
		// excluded staging slot — an unwritten half is garbage the caller
		// cannot observe).
		live[0] = exclude_reads ? RET_LIVE[0] & ~exclude_reads[0] : RET_LIVE[0];
		live[1] = exclude_reads ? RET_LIVE[1] & ~exclude_reads[1] : RET_LIVE[1];
		live[2] = exclude_reads ? RET_LIVE[2] & ~exclude_reads[2] : RET_LIVE[2];
		return;
	}
	mask_andnot(live, defs_mask(instr));
	mask_or(live, reads_mask(instr));
}

/** The slices of a lifted analysis the fixpoint drivers read — `Analysis`
 *  satisfies it structurally (no import: the CFG module lives above this
 *  leaf). */
export interface LivenessView {
	blocks: { start: number; end: number; succ: number[] }[];
	parsed: (AsmInstruction | null)[];
	kind: readonly string[];
	line_block?: number[];
}

/** The full backward liveness fixpoint: per-block live-in masks, iterated
 *  to the least fixpoint (reverse-order sweeps, exactly the old loop's
 *  convergence sequence). Unparsed instruction lines taint the block with
 *  the whole universe, as before. */
export function compute_live_in(
	view: LivenessView,
	exclude_args?: RegMask,
	exclude_reads?: RegMask,
): RegMask[] {
	const blocks = view.blocks;
	const parsed = view.parsed;
	const kind = view.kind;
	const live_in: RegMask[] = blocks.map(() => new Uint32Array(MASK_WORDS));
	const scratch = new Uint32Array(MASK_WORDS);
	let changed = true;
	while (changed) {
		changed = false;
		for (let bi = blocks.length - 1; bi >= 0; bi--) {
			const blk = blocks[bi];
			scratch[0] = 0;
			scratch[1] = 0;
			scratch[2] = 0;
			for (const s of blk.succ) {
				const li = live_in[s];
				scratch[0] |= li[0];
				scratch[1] |= li[1];
				scratch[2] |= li[2];
			}
			for (let i = blk.end; i >= blk.start; i--) {
				if (kind[i] !== "instr") continue;
				const instr = parsed[i];
				if (instr) transfer_mask(instr, scratch, exclude_args, exclude_reads);
				else {
					scratch[0] |= ALL_MASK[0];
					scratch[1] |= ALL_MASK[1];
					scratch[2] |= ALL_MASK[2];
				}
			}
			const cur = live_in[bi];
			if (scratch[0] !== cur[0] || scratch[1] !== cur[1] || scratch[2] !== cur[2]) {
				cur[0] = scratch[0];
				cur[1] = scratch[1];
				cur[2] = scratch[2];
				changed = true;
			}
		}
	}
	return live_in;
}

/** Liveness immediately before instruction line `f` — the successors'
 *  live-in union walked backward over the rest of f's block (strictly
 *  below f: (blk.end, f]), i.e. live-before(f) as the point queries need
 *  it. Zero mask when f sits in no block (the caller decides whether that
 *  means "refuse" — staging-elide does). */
export function live_before(
	view: LivenessView,
	live_in: RegMask[],
	f: number,
	exclude_args?: RegMask,
	exclude_reads?: RegMask,
): RegMask {
	const out = new Uint32Array(MASK_WORDS);
	const blk = view.line_block ? view.line_block[f] : -1;
	if (blk < 0) return out;
	const b = view.blocks[blk];
	for (const s of b.succ) {
		const li = live_in[s];
		mask_or(out, li);
	}
	for (let k = b.end; k > f; k--) {
		if (view.kind[k] !== "instr") continue;
		const instr = view.parsed[k];
		if (instr) transfer_mask(instr, out, exclude_args, exclude_reads);
		else {
			mask_or(out, ALL_MASK);
		}
	}
	return out;
}
