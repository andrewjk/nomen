/**
 * Pointer-walk strength reduction (ASM_PLAN_7 tranche 6). Clang's
 * spectral-norm loop walks the pointer — `ldr d3, [x16], #8`, the index
 * register gone entirely — while we re-derive `[base, j, lsl #3]` every
 * iteration (cause 5). When a validated cycle's induction indexes a
 * loop-invariant base with a fixed scale, the addressing rewrites to a
 * WALKED register:
 *
 *     add w, base, j, lsl #k     ; preheader — w = base + j·2^k
 *     .while_N:
 *       ldr x0, [w]              ; every [base, j, lsl #k] → [w]
 *       …
 *       add j, j, #m             ; the induction's latch increment
 *       add w, w, #(m·2^k)       ; the walk tracks j exactly
 *       b .while_N
 *
 * Soundness model:
 *
 * - The cycle is the shared validator (single entry — header provenance
 *   from inside — no calls; the preheader add runs exactly once per entry
 *   and dominates the body). The preheader reads j's ENTRY value, which
 *   is by definition the value reaching the header on the first iteration.
 * - j is defined exactly once in the cycle, by `add j, j, #m` in the
 *   latch; base is defined nowhere in the cycle and is not sp/fp. w then
 *   satisfies the invariant w ≡ base + j·2^k at the header of EVERY
 *   iteration: entry init, plus a +m·2^k bump per iteration matching the
 *   +m·(2^k)-byte growth of base + j·2^k.
 * - Every access rewritten shares the same base, induction, and scale —
 *   a mixed-scale group refuses (one walked pointer cannot track two
 *   strides), and the textual rewrite must cover every parsed access
 *   (a spacing mismatch refuses rather than half-rewrite).
 * - j itself is untouched: its other uses (loop guard, arithmetic) keep
 *   reading the induction; only the addressing operands are rewritten.
 * - The walk register comes from the intra-statement scratch pair
 *   (x16/x17) and must be textually absent from the ENTIRE function
 *   chunk — absent from the body is not enough, since an enclosing
 *   loop's if-converted select could live across this cycle in a
 *   register the body never mentions, and the latch bump would clobber
 *   it. Absent from the whole function is airtight.
 *
 * Runs AFTER stack-staging elision and BEFORE eliminate_dead_cycle_moves.
 * Kill-switch: `set_pointer_walk_enabled(false)` returns the text
 * unchanged (byte-identical off arm).
 */

import { function_chunk_start } from "./asm_cycle_dead_moves.ts";
import { exact_defs, find_containing_cycle } from "./asm_if_convert.ts";
import type { Operand } from "./asm_ir.ts";
import { build_tables } from "./asm_remat.ts";
import { parse_asm_instruction } from "./lift_asm.ts";

let walk_on = true;

export function pointer_walk_enabled(): boolean {
	return walk_on;
}

export function set_pointer_walk_enabled(enabled: boolean): void {
	walk_on = enabled;
}

const FORBIDDEN_REGS = new Set(["sp", "xzr", "x29", "x30", "fp", "lr", "wzr"]);
const WALK_POOL = ["x16", "x17"];

function is_x_reg(name: string): boolean {
	return /^x\d+$/.test(name) && !FORBIDDEN_REGS.has(name);
}

/** One walk candidate: the single post-index-able access plus the
 *  bookkeeping lines. */
interface WalkCandidate {
	base: string;
	j: string;
	scale: number; // 1 << k
	accesses: number[]; // line indexes (exactly one)
	latch_add: number; // the induction increment line
	header: number; // header label line
	w: string;
}

/** The mem operand shape: `[base, j, lsl #k]`, no writeback. Returns the
 *  base/j/k, or null. */
function walk_access(mem: Operand): { base: string; j: string; k: number } | null {
	if (mem.kind !== "mem") return null;
	if (!mem.offset || mem.offset.kind !== "reg") return null;
	if (!mem.scale || !Number.isInteger(Math.log2(mem.scale))) return null;
	if (mem.writeback || mem.postOffset !== undefined) return null;
	if (!is_x_reg(mem.base) || !is_x_reg(mem.offset.name)) return null;
	return { base: mem.base, j: mem.offset.name, k: Math.log2(mem.scale) };
}

function find_walk_one(lines: string[]): WalkCandidate | null {
	const { parsed, labels, jumps } = build_tables(lines.join("\n"));

	// Jump-targeted labels inside a candidate cycle make the body
	// conditional (an inner diamond) — the post-index access would skip
	// bumps on some iterations and desync from the induction.
	const targeted = new Set<number>();
	for (const j of jumps) {
		if (j.target !== null) targeted.add(j.target);
	}

	// All (base, j, k) access groups in the text. Vector (q/v) accesses
	// belong to the NEON planner's closed-form loops — never walked.
	const groups = new Map<string, { base: string; j: string; k: number; lines: number[] }>();
	for (let i = 0; i < parsed.length; i++) {
		const instr = parsed[i];
		if (!instr) continue;
		const is_vector = instr.operands.some((o) => o.kind === "reg" && /^[qv]\d+/.test(o.name));
		if (is_vector) continue;
		for (const o of instr.operands) {
			const acc = walk_access(o);
			if (!acc) continue;
			const key = `${acc.base}|${acc.j}|${acc.k}`;
			const g = groups.get(key);
			if (g) g.lines.push(i);
			else groups.set(key, { ...acc, lines: [i] });
		}
	}

	for (const [, g] of groups) {
		// The FIRST access line anchors the cycle.
		const anchor = g.lines[0];
		const header = find_containing_cycle(labels, jumps, parsed, anchor, anchor);
		if (!header) continue;
		const { h, e } = header;

		// Post-index fusion requires the access to run EXACTLY ONCE per
		// iteration: a single access, in a body with no jump-targeted
		// label (no inner diamond — the loop-exit guard targets outside
		// the range and pairs with the access correctly).
		const in_cycle = g.lines.filter((l) => l > h && l < e);
		if (in_cycle.length !== 1) continue;
		let inner_target = false;
		for (let k = h + 1; k < e; k++) {
			if (targeted.has(k)) inner_target = true;
		}
		if (inner_target) continue;

		// j defined exactly once in the cycle, by `add j, j, #m`, m ≥ 1 —
		// the latch increment.
		const j_w = `w${g.j.slice(1)}`;
		let latch_add = -1;
		let multi_def = false;
		for (let k = h + 1; k < e; k++) {
			const c = parsed[k];
			if (!c) continue;
			const defs = exact_defs(c);
			if (defs.includes(g.j) || defs.includes(j_w)) {
				if (
					latch_add === -1 &&
					c.op === "add" &&
					c.operands.length === 3 &&
					c.operands[0].kind === "reg" &&
					c.operands[0].name === g.j &&
					c.operands[1].kind === "reg" &&
					c.operands[1].name === g.j &&
					c.operands[2].kind === "imm" &&
					c.operands[2].value >= 1n
				) {
					latch_add = k;
					continue;
				}
				multi_def = true;
				break;
			}
		}
		if (multi_def || latch_add === -1) continue;

		// base invariant: defined nowhere in the cycle, never sp/fp.
		const base_w = `w${g.base.slice(1)}`;
		let base_def = false;
		for (let k = h + 1; k < e && !base_def; k++) {
			const c = parsed[k];
			if (!c) continue;
			const defs = exact_defs(c);
			if (defs.includes(g.base) || defs.includes(base_w)) base_def = true;
		}
		if (base_def) continue;

		// Walk register: intra-statement scratch, absent from the WHOLE
		// function chunk (an enclosing loop's select could live across this
		// cycle in a register the body never mentions).
		const chunk_start = function_chunk_start(lines, h);
		let chunk_end = lines.length;
		{
			let prev = "";
			for (let i = chunk_start; i < lines.length; i++) {
				const t = lines[i].trim();
				if (!t) continue;
				if (i > chunk_start && (prev === "ret" || prev.startsWith(".data"))) {
					chunk_end = i;
					break;
				}
				prev = t;
			}
		}
		const chunk_text = lines.slice(chunk_start, chunk_end).join("\n");
		let w: string | null = null;
		for (const cand of WALK_POOL) {
			const n = Number(cand.slice(1));
			const re = new RegExp(`\\b(?:x|w|d|s|q|v)${n}\\b`);
			if (!re.test(chunk_text)) {
				w = cand;
				break;
			}
		}
		if (!w) continue;

		return {
			base: g.base,
			j: g.j,
			scale: 1 << g.k,
			accesses: in_cycle,
			latch_add,
			header: h,
			w,
		};
	}
	return null;
}

/** Rewrite one candidate: the single access becomes post-index
 *  `[w], #stride` (load/store + walk fused — clang's exact form), and the
 *  preheader materializes w once. No latch bump: the post-index carries
 *  it. */
function apply_walk(lines: string[], c: WalkCandidate): string | null {
	const k = Math.log2(c.scale);
	let latch_imm = 0n;
	{
		const latch = parse_asm_instruction(lines[c.latch_add], c.latch_add + 1);
		if (!latch) return null;
		const imm = latch.operands[2];
		if (imm.kind !== "imm") return null;
		latch_imm = imm.value;
	}
	const byte_stride = Number(latch_imm) * c.scale;
	const forms = [`[${c.base}, ${c.j}, lsl #${k}]`, `[${c.base},${c.j},lsl #${k}]`];
	const out = lines.slice();
	for (const idx of c.accesses) {
		let done = false;
		for (const form of forms) {
			if (out[idx].includes(form)) {
				out[idx] = out[idx].split(form).join(`[${c.w}], #${byte_stride}`);
				done = true;
				break;
			}
		}
		if (!done) return null;
	}
	// Preheader init before the header: w = base + j_entry·2^k.
	const indent = lines[c.header].match(/^\s*/)?.[0] ?? "";
	const init = `${indent}add ${c.w}, ${c.base}, ${c.j}, lsl #${k}`;
	out.splice(c.header, 0, init);
	return out.join("\n");
}

/**
 * Phase entry — walk one (base, induction, scale) group per round until
 * no more convert.
 */
export function reduce_pointer_walks(code: string): string {
	if (!walk_on) return code;
	for (let round = 0; round < 8; round++) {
		const lines = code.split("\n");
		const c = find_walk_one(lines);
		if (!c) break;
		const next = apply_walk(lines, c);
		if (next === null) break;
		code = next;
	}
	return code;
}
