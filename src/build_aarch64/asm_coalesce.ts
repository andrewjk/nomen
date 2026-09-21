/**
 * Copy coalescing + derivation memoization over lifted assembly
 * (ASM_PLAN_4 item 2, tranche 1: the pidigits receiver-path receipt).
 *
 * The per-statement emission model stages every value through x0 with a
 * `mov xHome, x0` writeback, re-derives receiver paths per access, and
 * stages inline-call arguments with per-operand moves. Within a
 * straight-line region those moves are pure copies, and the sequence
 * `mov xA, xB; add xA, xA, #off1; ldr xA, [xA, #off2]` (a receiver's
 * data-pointer derivation) repeats per accessor. The 2026-09-06 census
 * of div_to's D4 multiply loop (38 instructions) counted ~17 copy
 * shuffles plus that derivation TWICE — none of it compute.
 *
 * Two cooperating transforms:
 *
 * 1. Copy propagation (forward scan): `mov xD, xS` records D == S. Reads
 *    of D are rewritten to S until (a) S is redefined (the alias
 *    diverges — physical xD still holds the copied value, reads fall
 *    back to it), (b) D is redefined, or (c) a region boundary. A move
 *    whose use was substituted is flagged; a backward two-set liveness
 *    pass (the eliminate_dead_copy_moves model) deletes exactly the
 *    flagged moves whose destination is dead below.
 *
 * 2. Derivation memoization (same scan): the consecutive sequence
 *    defines A = [[B+off1]+off2]. A later IDENTICAL sequence whose memo
 *    is still alive (B and the holders unredefined, no non-frame store
 *    in between, same region) is redundant — its three instructions are
 *    deleted and the holders keep carrying the value. This crosses the
 *    soundness boundary the statement-level staging pins
 *    (access_staging) cannot: a flag-form carry `if` taints the
 *    statement window but emits NO branch, so the text between two
 *    accessor statements is still one straight-line region here.
 *
 * Soundness model:
 *
 * - Regions break at labels, `b`/`br`/`ret` (control leaves),
 *   `bl`/`blr`/`svc` (clobbers + may write memory). Conditional branches
 *   keep copy state — their fall-through is straight-line and the taken
 *   arm lands on a label that clears (the float-forwarding convention) —
 *   but they still break a pending derivation (sequences are
 *   consecutive).
 * - Substitution only rewrites READ operands (dest-first convention;
 *   memory base/index are reads). AArch64 ops read sources before
 *   writing the destination, so substituting a dest-and-source register
 *   (`mul x0, x25, x12` → `mul x0, x25, x0`) is value-identical.
 * - w/x families are tracked by exact name; a def of either sibling
 *   kills copies recorded on the other (a w write clobbers the x view).
 * - Writeback memory forms are never substituted (the writeback target
 *   register identity is load-bearing).
 * - sp/x29 are excluded entirely (sp moves with pushes; x29 aliases it
 *   only at entry); xzr is never a copy source or destination.
 * - Derivation memoization adds its own memory rule: any store whose
 *   base is NOT x29/sp kills the memo (a store through a register could
 *   alias the loaded cell; [x29,#imm] frame slots provably cannot).
 *
 * The pass runs after the other asm passes; its output is re-validated
 * by the phase-1 lift (the validator is the shape contract). Kill-switch:
 * `set_copy_coalescing_enabled(false)` returns the text unchanged.
 */

import type { AsmInstruction, Operand } from "./asm_ir.ts";
import { is_cond } from "./asm_ir.ts";
import { parse_asm_instruction } from "./lift_asm.ts";

let coalescing_on = true;

export function copy_coalescing_enabled(): boolean {
	return coalescing_on;
}

export function set_copy_coalescing_enabled(enabled: boolean): void {
	coalescing_on = enabled;
}

/** Conditional branches in both spellings the backend emits: `b.hs` and
 *  the ARM32-style alias `bhs` (raw library blocks use both). */
function is_cond_branch_op(op: string): boolean {
	return (
		op.startsWith("b.") ||
		(op.length > 1 && op[0] === "b" && op !== "blr" && op !== "br" && is_cond(op.slice(1)))
	);
}

/** Registers never tracked as copies and never substituted. */
const FIXED_REGS = new Set(["sp", "x29", "xzr", "wsp", "wzr"]);

function sibling_reg(name: string): string | null {
	if (/^w\d+$/.test(name)) return `x${name.slice(1)}`;
	if (/^x\d+$/.test(name)) return `w${name.slice(1)}`;
	return null;
}

function is_xfam(name: string): boolean {
	return /^x\d+$/.test(name) || /^w\d+$/.test(name);
}

function mov_copy_operands(instr: AsmInstruction): { dst: string; src: string } | null {
	if (instr.op !== "mov" || instr.operands.length !== 2) return null;
	const d = instr.operands[0];
	const s = instr.operands[1];
	if (d.kind !== "reg" || s.kind !== "reg") return null;
	if (!is_xfam(d.name) || !is_xfam(s.name)) return null;
	if (FIXED_REGS.has(d.name) || FIXED_REGS.has(s.name)) return null;
	if (d.name === s.name) return null;
	return { dst: d.name, src: s.name };
}

/** Registers an instruction WRITES (exact, dest-first). */
function exact_defs(instr: AsmInstruction): string[] {
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

/** A reference to a register operand position. The mem-offset reg shape
 *  is narrower than the top-level Operand reg (no cls/width), so both
 *  shapes unify here — substitution only mutates `name`. */
type RegRef = Operand | { kind: "reg"; name: string };

interface RegRead {
	reg: string;
	operand: RegRef;
	is_mem_part: boolean;
}

/** Registers an instruction READS: every register operand outside the
 *  LEADING DEF POSITIONS, plus memory base/index registers (always reads —
 *  even when a base doubles as the destination, the OLD value is
 *  consumed). Position-based: a dest-and-source register (`eor x24,
 *  x24, x23`) reads its own old value at the source position and MUST
 *  count — name-matching against the def set would hide it and let a
 *  load-bearing copy of that register be deleted. */
function reads_of(instr: AsmInstruction): RegRead[] {
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
			skip = 0;
			break;
		case "ldp":
			skip = 2;
			break;
		case "blr":
		case "br":
		case "cbz":
		case "cbnz":
		case "tbz":
		case "tbnz":
			// The leading register is a READ (branch target / tested value).
			skip = 0;
			break;
		default:
			skip = 1;
			break;
	}
	const out: RegRead[] = [];
	let reg_seen = 0;
	for (const o of instr.operands) {
		if (o.kind === "reg") {
			if (reg_seen++ >= skip) out.push({ reg: o.name, operand: o, is_mem_part: false });
		} else if (o.kind === "mem") {
			out.push({ reg: o.base, operand: o, is_mem_part: true });
			if (o.offset?.kind === "reg") {
				out.push({ reg: o.offset.name, operand: o.offset, is_mem_part: true });
			}
		}
	}
	return out;
}

function store_bases(instr: AsmInstruction): string[] {
	const bases: string[] = [];
	if (instr.op.startsWith("st")) {
		for (const o of instr.operands) {
			if (o.kind === "mem") bases.push(o.base);
		}
	}
	return bases;
}

function has_writeback_mem(instr: AsmInstruction): boolean {
	return instr.operands.some((o) => o.kind === "mem" && o.writeback !== undefined);
}

/** Re-render an instruction from its parsed form (only called for lines
 *  where at least one register operand was substituted). */
function render(instr: AsmInstruction, indent: string): string {
	const parts = instr.operands.map(render_operand);
	return `${indent}${instr.op} ${parts.join(", ")}`;
}

function render_operand(o: Operand): string {
	switch (o.kind) {
		case "reg":
			return o.name;
		case "imm":
			return o.raw;
		case "label":
			return o.name;
		case "cond":
			return o.code;
		case "mem": {
			let inner = o.base;
			if (o.offset?.kind === "imm") inner += `, #${o.offset.value}`;
			else if (o.offset?.kind === "reg") inner += `, ${o.offset.name}`;
			// The lift stores the byte multiplier (1 << shift); the textual
			// form is the shift amount.
			if (o.scale !== undefined) inner += `, lsl #${Math.log2(o.scale)}`;
			if (o.writeback === "pre") return `[${inner}]!`;
			if (o.writeback === "post") return `[${o.base}], #${o.postOffset ?? 0}`;
			return `[${inner}]`;
		}
	}
}

interface CopyEntry {
	src: string;
	movIdx: number;
	flagged: boolean;
}

interface Memo {
	base: string;
	off1: bigint;
	off2: bigint;
	holders: Set<string>;
}

interface Pending {
	a: string;
	b: string;
	stage: 1 | 2;
	off1?: bigint;
	/** Snapshot of a live memo (same base, holding this sequence's dest)
	 *  taken at the mov — before the sequence's own defs invalidate the
	 *  holder set. The ldr arm trusts it: nothing can invalidate the cell
	 *  inside the consecutive sequence (a store would break pending). */
	snap?: { off1: bigint; off2: bigint };
}

export function coalesce_copies(code: string): string {
	if (!coalescing_on) return code;
	const lines = code.split("\n");
	/** Emitted image; null = deleted. */
	const out: (string | null)[] = [];
	const parsed: (AsmInstruction | null)[] = [];
	const copies = new Map<string, CopyEntry>();
	let memo: Memo | null = null;
	let pending: Pending | null = null;
	/** After a deleted redundant derivation, the next `mov xD, xA` may be
	 *  the redundant tail copy. */
	let expect_tail: string | null = null;
	/** Emitted indices of movs with at least one substituted use. */
	const flagged_movs = new Set<number>();

	const kill_reg = (reg: string): void => {
		if (!reg) return;
		const sib = sibling_reg(reg);
		for (const [d, c] of copies) {
			if (d === reg || d === sib || c.src === reg || c.src === sib) {
				copies.delete(d);
			}
		}
		if (memo) {
			if (memo.base === reg || memo.base === sib) {
				memo = null;
			} else {
				for (const h of memo.holders) {
					if (h === reg || h === sib) memo.holders.delete(h);
				}
				if (memo.holders.size === 0) memo = null;
			}
		}
	};

	const clear_state = (): void => {
		copies.clear();
		memo = null;
		pending = null;
		expect_tail = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const text = lines[i];
		const trimmed = text.trim();
		if (!trimmed || trimmed.startsWith("//")) {
			out.push(text);
			parsed.push(null);
			continue;
		}
		const label_m = /^([A-Za-z_.$][\w.$]*):/.exec(trimmed);
		if (label_m || trimmed.startsWith(".") || /^[\w.$]+\s*=\s*[\w.$]+$/.exec(trimmed)) {
			clear_state();
			out.push(text);
			parsed.push(null);
			continue;
		}
		const instr = parse_asm_instruction(text, i + 1);
		if (!instr) {
			clear_state();
			out.push(text);
			parsed.push(null);
			continue;
		}
		const op = instr.op;

		// Hard region boundaries.
		if (op === "b" || op === "br" || op === "ret" || op === "bl" || op === "blr" || op === "svc") {
			clear_state();
			out.push(text);
			parsed.push(null);
			continue;
		}

		const emit_idx = out.length;
		const defs = exact_defs(instr);
		const reads = reads_of(instr);

		// --- redundant derivation tail ------------------------------------
		if (expect_tail !== null) {
			const t = mov_copy_operands(instr);
			if (t && t.src === expect_tail && memo && memo.holders.has(t.dst)) {
				// xD already holds the derived value — the copy is redundant.
				expect_tail = null;
				out.push(null);
				parsed.push(null);
				continue;
			}
			expect_tail = null;
		}

		// --- derivation recognition (pre-substitution operand names; the
		// stage-2 arm accepts both the raw and the substituted add form) ---
		let deleted_sequence = false;
		/** Deferred state applications: the sequence's own defs run in the
		 *  defs section below, so memo creation/extension must happen AFTER
		 *  them or the derivation's own write kills its holder entry. */
		let arm_memo: { base: string; off1: bigint; off2: bigint; a: string } | null = null;
		let arm_extend: string | null = null;
		const t = mov_copy_operands(instr);
		if (t) {
			const snap: { off1: bigint; off2: bigint } | undefined =
				memo && memo.base === t.src && memo.holders.has(t.dst)
					? { off1: memo.off1, off2: memo.off2 }
					: undefined;
			pending = { a: t.dst, b: t.src, stage: 1, snap };
			// A copy off a completed derivation extends its holder set.
			if (memo && !snap && memo.holders.has(t.src)) {
				arm_extend = t.dst;
			}
		} else if (
			op === "add" &&
			pending !== null &&
			pending.stage === 1 &&
			instr.operands.length === 3 &&
			instr.operands[0].kind === "reg" &&
			instr.operands[1].kind === "reg" &&
			instr.operands[2].kind === "imm" &&
			instr.operands[0].name === pending.a &&
			(instr.operands[1].name === pending.a || instr.operands[1].name === pending.b)
		) {
			const p: Pending = pending;
			pending = { a: p.a, b: p.b, stage: 2, off1: instr.operands[2].value, snap: p.snap };
		} else if (
			op === "ldr" &&
			pending !== null &&
			pending.stage === 2 &&
			pending.off1 !== undefined &&
			instr.operands.length === 2 &&
			instr.operands[0].kind === "reg" &&
			instr.operands[1].kind === "mem" &&
			instr.operands[1].writeback === undefined &&
			instr.operands[1].offset?.kind === "imm" &&
			instr.operands[0].name === pending.a &&
			instr.operands[1].base === pending.a
		) {
			const off2 = instr.operands[1].offset.value;
			const seq: Pending = pending;
			const off1: bigint = seq.off1!;
			pending = null;
			if (seq.snap && off1 === seq.snap.off1 && off2 === seq.snap.off2) {
				// The re-derivation is redundant: the memo's holder carried the
				// value at the mov, and nothing inside the consecutive sequence
				// could invalidate the cell. Drop mov/add/ldr.
				const mov_idx = emit_idx - 2;
				const add_idx = emit_idx - 1;
				out[mov_idx] = null;
				out[add_idx] = null;
				out.push(null);
				parsed.push(null);
				const stale = copies.get(seq.a);
				if (stale && stale.movIdx === mov_idx) copies.delete(seq.a);
				// The deleted defs never happen — the sequence re-establishes
				// exactly this memo.
				memo = { base: seq.b, off1, off2, holders: new Set([seq.a]) };
				expect_tail = seq.a;
				deleted_sequence = true;
			} else {
				arm_memo = { base: seq.b, off1, off2, a: seq.a };
			}
		} else if (!t) {
			// Any non-mov instruction that is not a matching add/ldr breaks
			// the consecutive sequence requirement.
			pending = null;
		}
		if (deleted_sequence) continue;

		// --- substitution of read operands --------------------------------
		let changed = false;
		const indent = text.match(/^\s*/)?.[0] ?? "";
		// Round-trip guard: the structured form does not model every
		// textual feature (shifted ALU operands like `add x0, x1, x2,
		// lsl #6` attach to the register and would be dropped by the
		// renderer). Only rewrite lines whose pristine render is
		// byte-identical to the input — everything else passes through.
		const roundtrip = render(instr, indent) === text;
		if (!has_writeback_mem(instr) && !has_substitution_conflict(instr, defs) && roundtrip) {
			for (const r of reads) {
				const copy = copies.get(r.reg);
				if (!copy || !is_xfam(r.reg)) continue;
				// Never rewrite a move's own source into a self-move
				// (`mov x0, x19` with x0==x19 would become the no-op
				// `mov x0, x0`); the explicit deferral shape stays.
				if (
					op === "mov" &&
					instr.operands[0].kind === "reg" &&
					r.operand.kind === "reg" &&
					instr.operands[0].name === copy.src
				) {
					continue;
				}
				const new_name = copy.src;
				if (r.operand.kind === "reg") {
					r.operand.name = new_name;
					changed = true;
				} else if (r.operand.kind === "mem") {
					if (r.operand.base === r.reg) r.operand.base = new_name;
					if (r.operand.offset?.kind === "reg" && r.operand.offset.name === r.reg) {
						r.operand.offset.name = new_name;
					}
					changed = true;
				} else {
					continue;
				}
				copy.flagged = true;
				flagged_movs.add(copy.movIdx);
			}
		}

		const new_text = changed ? render(instr, indent) : text;
		out.push(new_text);
		parsed.push(instr);

		// --- memo memory-kill check ---------------------------------------
		if (memo) {
			for (const base of store_bases(instr)) {
				if (base !== "x29" && base !== "sp") memo = null;
			}
		}

		// --- defs processing ----------------------------------------------
		for (const d of defs) {
			kill_reg(d);
		}
		// Deferred memo applications: the instruction's own defs have run,
		// so a fresh derivation's holder survives (the ldr defines its own
		// destination) and a tail copy extends rather than kills.
		if (arm_memo) {
			memo = {
				base: arm_memo.base,
				off1: arm_memo.off1,
				off2: arm_memo.off2,
				holders: new Set([arm_memo.a]),
			};
		}
		if (arm_extend && memo) {
			memo.holders.add(arm_extend);
		}
		const rec = mov_copy_operands(instr);
		if (rec) {
			copies.set(rec.dst, { src: rec.src, movIdx: emit_idx, flagged: false });
		}
	}

	// --- backward deletion of flagged movs --------------------------------
	// The two-set model (live / tainted) of eliminate_dead_copy_moves, but
	// the taint at joins is computed from the TARGET BLOCK's upward-
	// exposed reads instead of tainting the whole universe: a label's or
	// branch's successor block names exactly the registers it may read
	// before defining, and only those block a deletion above. The
	// universe-taint version kept every staging move whose register was
	// never redefined below (the taint from a distant `ret` or `b.cond`
	// leaked across the whole loop body).

	/** Label name → first line index (named labels only). Positions are
	 *  into the EMITTED image (out/parsed — 1:1 with the input by
	 *  construction, since every input line pushes exactly one entry). */
	const label_pos = new Map<string, number>();
	for (let i = 0; i < out.length; i++) {
		const text_i = out[i];
		if (text_i === null) continue;
		const t = text_i.trim();
		const m = /^([A-Za-z_.$][\w.$]*):$/.exec(t);
		if (m && !label_pos.has(m[1])) label_pos.set(m[1], i);
	}

	/** Upward-exposed reads of the straight-line block starting at line
	 *  `start` (reads before any in-block definition), following plain
	 *  fall-through, unconditional branches, and conditional-branch taken
	 *  targets up to `depth` block transitions. Walks the EMITTED image —
	 *  substitution changed which registers the reads use, so the input
	 *  text would under-approximate. Null = the walk hit something it
	 *  does not model (unparseable line, indirect branch, depth/cap
	 *  overflow) — the caller falls back to universe taint. */
	const exposed_cache = new Map<string, Set<string> | null>();
	const exposed_from = (start: number, depth: number): Set<string> | null => {
		if (depth > 4) return null;
		const live = new Set<string>();
		const defined = new Set<string>();
		let count = 0;
		for (let j = start; j < out.length; j++) {
			const text_j = out[j];
			if (text_j === null) continue;
			const t = text_j.trim();
			if (!t || t.startsWith("//")) continue;
			if (/^[\w.$]+\s*=\s*[\w.$]+$/.test(t) || (t.startsWith(".") && !t.endsWith(":"))) {
				continue;
			}
			const lm = /^([A-Za-z_.$][\w.$]*):$/.exec(t);
			if (lm) {
				// Fell into a label: its block continues execution — look
				// through it (the join's predecessors were handled by the
				// caller's own label arm).
				const key = `${lm[1]}@${depth + 1}`;
				let sub: Set<string> | null;
				if (exposed_cache.has(key)) {
					sub = exposed_cache.get(key)!;
				} else {
					sub = exposed_from(j + 1, depth + 1);
					exposed_cache.set(key, sub);
				}
				if (!sub) return null;
				for (const r of sub) {
					if (!defined.has(r)) live.add(r);
				}
				break;
			}
			// Hard-boundary instructions (b/ret/bl/blr/svc) were pushed with
			// a null parsed entry for bookkeeping — re-parse them; the walk
			// needs their semantics.
			const instr = parsed[j] ?? parse_asm_instruction(text_j, j + 1);
			if (!instr) return null;
			const op = instr.op;
			if (op === "ret") {
				live.add("x0");
				live.add("x1");
				live.add("d0");
				live.add("d1");
				break;
			}
			if (op === "blr") return null;
			if (op === "bl") {
				// The call consumes its argument registers and DEFINES the
				// caller-saved set — but callee-saved registers flow through
				// UNCHANGED, so reads of them after the call are still
				// upward-exposed (a `bl foo; ldr x1, [x20, #16]` exposes x20
				// to everything above). The walk must continue.
				for (let a = 0; a <= 8; a++) {
					if (!defined.has(`x${a}`)) live.add(`x${a}`);
					if (!defined.has(`d${a}`)) live.add(`d${a}`);
				}
				for (let a = 0; a <= 17; a++) defined.add(`x${a}`);
				defined.add("x30");
				for (let a = 0; a <= 7; a++) defined.add(`d${a}`);
				continue;
			}
			if (op === "b" || op === "br") {
				if (op === "br") return null;
				const target = instr.operands.find((o) => o.kind === "label");
				const pos = target ? label_pos.get((target as { name: string }).name) : undefined;
				if (pos === undefined) return null;
				const key = `${(target as { name: string }).name}@${depth + 1}`;
				let sub: Set<string> | null;
				if (exposed_cache.has(key)) {
					sub = exposed_cache.get(key)!;
				} else {
					sub = exposed_from(pos + 1, depth + 1);
					exposed_cache.set(key, sub);
				}
				if (!sub) return null;
				for (const r of sub) {
					if (!defined.has(r)) live.add(r);
				}
				break;
			}
			if (is_cond_branch_op(op) || op === "cbz" || op === "cbnz" || op === "tbz" || op === "tbnz") {
				// Fall-through continues below; the taken edge lands on a
				// label whose block's reads flow back here.
				const target = instr.operands.find((o) => o.kind === "label");
				const pos = target ? label_pos.get((target as { name: string }).name) : undefined;
				if (pos === undefined) return null;
				const key = `${(target as { name: string }).name}@${depth + 1}`;
				let sub: Set<string> | null;
				if (exposed_cache.has(key)) {
					sub = exposed_cache.get(key)!;
				} else {
					sub = exposed_from(pos + 1, depth + 1);
					exposed_cache.set(key, sub);
				}
				if (!sub) return null;
				for (const r of sub) {
					if (!defined.has(r)) live.add(r);
				}
				for (const r of reads_of(instr)) {
					if (!defined.has(r.reg)) live.add(r.reg);
				}
				continue;
			}
			if (++count > 128) return null;
			for (const r of reads_of(instr)) {
				if (!defined.has(r.reg)) live.add(r.reg);
			}
			for (const d of exact_defs(instr)) defined.add(d);
		}
		return live;
	};

	const live = new Set<string>();
	const tainted = new Set<string>();
	const ALL_TRACKED: string[] = [];
	for (let r = 0; r <= 30; r++) ALL_TRACKED.push(`x${r}`, `w${r}`, `d${r}`);
	ALL_TRACKED.push("sp", "xzr");
	const taint_all = (): void => {
		for (const r of ALL_TRACKED) tainted.add(r);
	};

	for (let i = out.length - 1; i >= 0; i--) {
		const text = out[i];
		if (text === null) continue;
		const trimmed = text.trim();
		if (!trimmed || trimmed.startsWith("//")) continue;
		const label_m = /^([A-Za-z_.$][\w.$]*):$/.exec(trimmed);
		if (label_m || trimmed.startsWith(".") || /^[\w.$]+\s*=\s*[\w.$]+$/.exec(trimmed)) {
			// A label is a join: its block's exposed reads (plus every
			// other predecessor's unknown contribution) must stay live.
			// Data directives and aliases keep the universe taint.
			if (label_m) {
				const sub = exposed_from(i + 1, 0);
				if (!sub) {
					taint_all();
				} else {
					for (const r of sub) {
						live.add(r);
						tainted.add(r);
					}
				}
			} else {
				taint_all();
			}
			continue;
		}
		// Hard-boundary lines (b/ret/bl/blr/svc) carry a null parsed entry
		// for bookkeeping — re-parse them; their defs/reads still matter
		// here. Only genuinely unparseable lines take the conservative path.
		const instr = parsed[i] ?? parse_asm_instruction(text, i + 1);
		if (!instr) {
			live.clear();
			taint_all();
			continue;
		}
		const op = instr.op;
		if (op === "ret") {
			// The return value rides x0 (x1/d0/d1 for fat pairs); nothing
			// below the ret executes, so this is exact knowledge.
			live.clear();
			live.add("x0");
			live.add("x1");
			live.add("d0");
			live.add("d1");
			tainted.clear();
			continue;
		}
		if (op === "bl" || op === "blr") {
			// Arguments x0-x8 / d0-d7 are READ; x9-x17 and lr are defined.
			for (let a = 0; a <= 8; a++) {
				live.add(`x${a}`);
				tainted.delete(`x${a}`);
				live.add(`d${a}`);
				tainted.delete(`d${a}`);
			}
			for (let a = 9; a <= 17; a++) {
				live.delete(`x${a}`);
				tainted.delete(`x${a}`);
			}
			live.delete("x30");
			tainted.delete("x30");
			continue;
		}
		if (op === "br") {
			taint_all();
			continue;
		}
		if (
			op === "b" ||
			is_cond_branch_op(op) ||
			op === "cbz" ||
			op === "cbnz" ||
			op === "tbz" ||
			op === "tbnz"
		) {
			const target = instr.operands.find((o) => o.kind === "label");
			const pos = target ? label_pos.get((target as { name: string }).name) : undefined;
			if (pos === undefined) {
				taint_all();
				continue;
			}
			const sub = exposed_from(pos + 1, 1);
			if (!sub) {
				taint_all();
				continue;
			}
			if (op === "b") {
				// Unconditional: the block ends here — exact replacement.
				live.clear();
				tainted.clear();
			}
			for (const r of sub) {
				live.add(r);
				if (op !== "b") tainted.add(r);
			}
			for (const r of reads_of(instr)) {
				live.add(r.reg);
				tainted.delete(r.reg);
			}
			continue;
		}

		if (flagged_movs.has(i)) {
			const t = mov_copy_operands(instr);
			if (t && /^x\d+$/.test(t.dst) && !live.has(t.dst) && !tainted.has(t.dst)) {
				out[i] = null;
				continue;
			}
		}

		// Backward transfer: defs first (def-and-read keeps the need alive).
		for (const d of exact_defs(instr)) {
			live.delete(d);
			tainted.delete(d);
			const sib = sibling_reg(d);
			if (sib) tainted.delete(sib);
		}
		for (const r of reads_of(instr)) {
			live.add(r.reg);
			tainted.delete(r.reg);
			const sib = sibling_reg(r.reg);
			if (sib) tainted.delete(sib);
		}
	}

	return out.map((l) => l ?? "").join("\n");
}

/** Substitution is skipped on instructions where a register appears BOTH
 *  as a leading def and as a memory base/offset — rewriting the shared
 *  token positionally would need operand-position awareness the simple
 *  read walk does not track. (The recognizer's own `ldr xA, [xA, #off]`
 *  reaches substitution with no active copy on xA, so it is unaffected.) */
function has_substitution_conflict(instr: AsmInstruction, defs: string[]): boolean {
	if (defs.length === 0) return false;
	for (const o of instr.operands) {
		if (o.kind === "mem") {
			if (defs.includes(o.base)) return true;
			if (o.offset?.kind === "reg" && defs.includes(o.offset.name)) return true;
		}
	}
	return false;
}
