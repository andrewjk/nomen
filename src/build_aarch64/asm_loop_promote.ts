/**
 * Loop-carried slot promotion over lifted assembly (ASM_PLAN_4 item 2,
 * tranche 2: the mul_carry-class carry slot round-trips).
 *
 * A scalar written AND read inside an innermost loop body lives in a frame
 * slot because the allocator's pools are function-wide (the carry is live
 * into the loop header, so the caller-saved extension pool is forbidden,
 * its raw textual reads sit below MIN_READS, and it is written — the
 * loop-invariant route refuses it). Every iteration pays `ldr`/`str`
 * round-trips: the D4-multiply carry block is seven instructions with four
 * memory ops on `[x29, #288]`.
 *
 * Inside a call-free, branch-free loop CYCLE the slot's value can live in
 * a caller-saved scratch register instead:
 *
 * - the entry load is inserted before the header label (fall-through only —
 *   the back-edge skips it, so the register stays current across
 *   iterations);
 * - every 64-bit `ldr xR, [x29, #N]` becomes `mov xR, x16` and every
 *   `str xS, [x29, #N]` becomes `mov x16, xS` — register renames, zero
 *   memory ops per iteration;
 * - a sync store is inserted after each exit label (the conditional exits
 *   land outside the cycle), so post-loop reads of the slot see the final
 *   value;
 * - the copy coalescer (running after) folds the renamed moves into the
 *   consuming instructions.
 *
 * The carry-INCREMENT collapse rides here too: the flag-form tail
 * `cset xT, cc / mov xA, x16 / add xA, xA, xT / mov x16, xA` is exactly
 * `cinc x16, x16, cc` — the flags are untouched by the removed moves.
 *
 * Soundness model:
 *
 * - Cycles are [label L … `b L`] ranges whose body contains NO other
 *   label (innermost only — the structured lowering emits branch-free
 *   bodies for the flag-form loops) and no `bl`/`blr`/`svc`/`ret` (calls
 *   clobber x16/x17).
 * - Single entry: every jump to the header label must originate inside
 *   the cycle. Single-writer exits: every jump to an exit-target label
 *   must originate inside the cycle, so the sync store can never run with
 *   a stale register (other entries would need their own sync).
 * - Candidate slots are 64-bit `ldr`/`str`-only `[x29, #imm]` accesses
 *   with at least one store in the cycle; ANY other access shape anywhere
 *   in the function (sub-width load/store, ldp/stp, or an
 *   `add xK, x29, #imm` address escape) disqualifies the slot.
 * - The promotion register must appear nowhere in the cycle (the panic
 *   nodes use x16, but only in terminal panic paths that never join the
 *   promoted region — a use inside the cycle is the conservative
 *   refusal).
 * - `mov` renames cannot clobber flags, so the cset→cinc fold keeps the
 *   flag provenance of the preceding `adds`/`subs` intact.
 *
 * Runs BEFORE coalesce_copies (the renames feed its substitution).
 * Kill-switch: `set_loop_slot_promotion_enabled(false)` returns the text
 * unchanged.
 */

import type { AsmInstruction } from "./asm_ir.ts";
import { is_cond } from "./asm_ir.ts";
import { parse_asm_instruction } from "./lift_asm.ts";

let loop_promote_on = true;

export function loop_slot_promotion_enabled(): boolean {
	return loop_promote_on;
}

export function set_loop_slot_promotion_enabled(enabled: boolean): void {
	loop_promote_on = enabled;
}

const PROMO_REGS = ["x16", "x17"];

function label_of(text: string): string | null {
	const m = /^([A-Za-z_.$][\w.$]*):$/.exec(text.trim());
	return m ? m[1] : null;
}

function mem_slot(instr: AsmInstruction): { base: string; off: string; form: string } | null {
	for (const o of instr.operands) {
		if (
			o.kind === "mem" &&
			o.writeback === undefined &&
			o.base === "x29" &&
			o.offset?.kind === "imm"
		) {
			return { base: o.base, off: o.offset.value.toString(), form: instr.op };
		}
	}
	return null;
}

/** The 64-bit x-register store/load forms eligible for renaming. */
const RENAME_FORMS = new Set(["ldr", "str"]);

export function promote_loop_slots(code: string): string {
	if (!loop_promote_on) return code;
	const lines = code.split("\n");

	const parsed: (AsmInstruction | null)[] = [];
	const labels = new Map<string, number>();
	const jumps: { from: number; target: string; cond: boolean }[] = [];
	const dirty_slots = new Set<string>();
	/** x29-relative accesses by offset inside the whole file, per line. */
	const slot_ops: { off: string; read: boolean; line: number }[] = [];

	for (let i = 0; i < lines.length; i++) {
		const text = lines[i];
		const trimmed = text.trim();
		const lbl = label_of(text);
		if (lbl) {
			labels.set(lbl, i);
			parsed.push(null);
			continue;
		}
		if (
			!trimmed ||
			trimmed.startsWith("//") ||
			trimmed.startsWith(".") ||
			/^[\w.$]+\s*=\s*[\w.$]+$/.exec(trimmed)
		) {
			parsed.push(null);
			continue;
		}
		const instr = parse_asm_instruction(text, i + 1);
		parsed.push(instr);
		if (!instr) continue;
		const op = instr.op;
		if (
			op === "b" ||
			is_cond_branch(instr.op) ||
			op === "cbz" ||
			op === "cbnz" ||
			op === "tbz" ||
			op === "tbnz"
		) {
			const target = instr.operands.find((o) => o.kind === "label");
			if (target) {
				jumps.push({ from: i, target: (target as { name: string }).name, cond: op !== "b" });
			}
		}
		if (op === "add" || op === "adds" || op === "sub" || op === "subs") {
			// An x29-derived address escape: the slot may be reached through
			// the register (phase-2's normalize idiom, ref/sret marshalling).
			// These use REGISTER operands, not mem syntax.
			if (
				instr.operands.length === 3 &&
				instr.operands[1].kind === "reg" &&
				instr.operands[1].name === "x29" &&
				instr.operands[2].kind === "imm"
			) {
				dirty_slots.add(instr.operands[2].value.toString());
			}
		}
		if (op === "ldr" || op === "str") {
			const m = mem_slot(instr);
			if (m && m.base === "x29") {
				if (
					RENAME_FORMS.has(op) &&
					instr.operands[0].kind === "reg" &&
					instr.operands[0].name.startsWith("x") &&
					(op === "str" ? true : instr.operands[0].width === 64)
				) {
					slot_ops.push({ off: m.off, read: op === "ldr", line: i });
				} else {
					dirty_slots.add(m.off);
				}
			}
		} else {
			const m = mem_slot(instr);
			if (m && m.base === "x29") dirty_slots.add(m.off);
		}
	}

	/** Cycles: header label → matching unconditional back-edge. The
	 *  back-edge may sit past intermediate labels (`.while_update_N:`) —
	 *  the cycle is the whole range. Innermost-first: a cycle whose range
	 *  overlaps an already-promoted (owned) range is skipped. */
	const out = lines.slice();
	const owned = new Set<number>();
	const cycles: { head: string; headIdx: number; end: number }[] = [];
	for (const [head, headIdx] of [...labels.entries()]) {
		for (const jp of jumps) {
			if (jp.target !== head || jp.cond || jp.from <= headIdx) continue;
			cycles.push({ head, headIdx, end: jp.from });
			break;
		}
	}
	cycles.sort((a, b) => a.end - a.headIdx - (b.end - b.headIdx));

	for (const { head, headIdx, end } of cycles) {
		// No calls inside (they clobber the promotion registers), no ret,
		// and no overlap with an already-promoted inner cycle.
		let eligible = true;
		for (let j = headIdx; j <= end; j++) {
			if (owned.has(j)) eligible = false;
			const instr = parsed[j];
			if (
				instr &&
				(instr.op === "bl" || instr.op === "blr" || instr.op === "svc" || instr.op === "ret")
			)
				eligible = false;
		}
		if (!eligible) continue;

		// Provenance: every jump to the header must come from inside.
		let header_ok = true;
		for (const jp of jumps) {
			if (jp.target === head && !(jp.from > headIdx && jp.from <= end)) header_ok = false;
		}
		if (!header_ok) continue;

		// Exit targets: conditional targets defined OUTSIDE the cycle.
		const exits = new Map<string, number>();
		for (let j = headIdx + 1; j < end; j++) {
			const instr = parsed[j];
			if (!instr) continue;
			if (
				is_cond_branch(instr.op) ||
				instr.op === "cbz" ||
				instr.op === "cbnz" ||
				instr.op === "tbz" ||
				instr.op === "tbnz"
			) {
				const target = instr.operands.find((o) => o.kind === "label");
				const name = target ? (target as { name: string }).name : undefined;
				if (name && labels.has(name) && (labels.get(name)! < headIdx || labels.get(name)! > end)) {
					exits.set(name, labels.get(name)!);
				}
			}
		}
		// Exit provenance: every jump to each exit label must come from
		// inside THIS cycle.
		let exits_ok = exits.size > 0;
		for (const exit_label of exits.keys()) {
			for (const jp of jumps) {
				if (jp.target === exit_label && !(jp.from > headIdx && jp.from <= end)) exits_ok = false;
			}
		}
		if (!exits_ok) continue;

		// Candidate slots: 64-bit ldr AND str on the same offset, no dirty
		// history anywhere in the file.
		const reads = new Set<string>();
		const writes = new Set<string>();
		for (let j = headIdx + 1; j < end; j++) {
			const instr = parsed[j];
			if (!instr) continue;
			const m = mem_slot(instr);
			if (!m || m.base !== "x29") continue;
			if (instr.op === "ldr") reads.add(m.off);
			if (instr.op === "str") writes.add(m.off);
		}
		const candidates: string[] = [];
		for (const off of writes) {
			if (!reads.has(off)) continue;
			if (dirty_slots.has(off)) continue;
			candidates.push(off);
		}
		// Read-only candidates (ASM_PLAN_6 tranche 1): slots the cycle only
		// READS — the hoisted invariant index bases (`_vn` temps). The
		// entry load makes the promotion register the live copy and NO
		// sync store is needed: the cycle never writes the slot, so memory
		// stays authoritative for every access outside the cycle. (The one
		// staleness hazard — an enclosing cycle promoting the same slot as
		// a write-carry and updating only its register — cannot occur: the
		// overlap guard skips any cycle containing an already-promoted
		// inner one, so an outer write-promotion around this cycle never
		// exists.)
		const readonly_candidates: string[] = [];
		for (const off of reads) {
			if (writes.has(off)) continue;
			if (dirty_slots.has(off)) continue;
			readonly_candidates.push(off);
		}

		// Promotion registers: unused as any operand inside the cycle.
		const cycle_regs = new Set<string>();
		for (let j = headIdx + 1; j < end; j++) {
			const instr = parsed[j];
			if (!instr) continue;
			for (const o of instr.operands) {
				if (o.kind === "reg") cycle_regs.add(o.name);
				else if (o.kind === "mem") {
					cycle_regs.add(o.base);
					if (o.offset?.kind === "reg") cycle_regs.add(o.offset.name);
				}
			}
		}
		const promo: string[] = [];
		for (const reg of PROMO_REGS) {
			if (promo.length >= 2) break;
			if (!cycle_regs.has(reg)) promo.push(reg);
		}

		// Derivation candidates (ASM_PLAN_6 tranche 2): the Buffer
		// data-pointer pair `add xD, xB, #imm / ldr xD, [xD, #imm2]` — the
		// per-iteration receiver derivation. In a call-free cycle the
		// digits.data field cannot change (ensure/grow are calls; the
		// cycle's stores go through the POINTER to heap data, never to the
		// struct field), so the pair hoists like a read-only slot: entry
		// recomputes it into the promotion register, the in-cycle
		// definition disappears, and every later xD use renames. Requires
		// the pair to be the cycle's ONLY definition of xD, xB unwritten,
		// and no direct store to the [xB, #imm] field (aliasing guard).
		type Deriv = {
			first_idx: number;
			last_idx: number;
			xD: string;
			xB: string;
			imm: string;
			imm2: string;
		};
		const derivs: Deriv[] = [];
		for (let j = headIdx + 1; j < end - 1; j++) {
			// Two-line form: add xD, xB, #imm / ldr xD, [xD, #imm2].
			// Three-line form: mov xD, xB / add xD, xD, #imm / ldr xD,
			// [xD, #imm2] — the base register arrives through a staging
			// copy the hoist makes unnecessary (entry adds from xB
			// directly).
			const a = parsed[j];
			const l = parsed[j + 1];
			if (!a || !l) continue;
			if (a.op !== "add" || a.operands.length !== 3) continue;
			if (l.op !== "ldr" || l.operands.length !== 2) continue;
			if (a.operands[0].kind !== "reg" || a.operands[2].kind !== "imm") continue;
			const xD = (a.operands[0] as { name: string }).name;
			let xB = (a.operands[1] as { name?: string }).name ?? "";
			let first = j;
			if (xD === xB) {
				if (j - 1 <= headIdx) continue;
				const cp = parsed[j - 1];
				if (!cp || cp.op !== "mov" || cp.operands.length !== 2) continue;
				if (cp.operands[0].kind !== "reg" || cp.operands[1].kind !== "reg") continue;
				if ((cp.operands[0] as { name: string }).name !== xD) continue;
				xB = (cp.operands[1] as { name: string }).name;
				if (xB === xD) continue;
				first = j - 1;
			}
			// A frame-derived pair reads THROUGH a stack slot (`[x29+off]`
			// then dereference) — the slot is a mutable variable the cycle
			// may advance (the for-of element pointer). Only register-born
			// struct fields (params/locals in callee-saved registers) are
			// invariant.
			if (xB === "x29" || xB === "sp") continue;
			if (xD !== (l.operands[0] as { name?: string }).name) continue;
			const lm = l.operands[1];
			if (
				lm.kind !== "mem" ||
				lm.base !== xD ||
				lm.writeback !== undefined ||
				lm.offset?.kind !== "imm"
			)
				continue;
			// Local shape gate: a use of xD BEFORE the sequence means xD
			// carried an earlier value here — refuse. (The cycle may hold
			// SEVERAL occurrences of the same derivation — one per accessor
			// access; grouping and the cycle-wide gates happen below.)
			let dominated = true;
			for (let k = headIdx + 1; k < first; k++) {
				const c = parsed[k];
				if (!c) continue;
				for (const o of c.operands) {
					const reads_xD =
						(o.kind === "reg" && o.name === xD) ||
						(o.kind === "mem" &&
							(o.base === xD || (o.offset?.kind === "reg" && o.offset.name === xD)));
					if (reads_xD) dominated = false;
				}
			}
			if (!dominated) continue;
			derivs.push({
				first_idx: first,
				last_idx: j + 1,
				xD,
				xB,
				imm: String((a.operands[2] as { value: number | bigint }).value),
				imm2: String(lm.offset.value),
			});
		}
		// Group identical sequences (same xD/xB/imm/imm2 — one derivation
		// per accessor access). A group hoists when its members are the
		// cycle's ONLY definitions of xD, xB is unwritten outside them,
		// and no escape/field-store of the base struct exists outside
		// them.
		const deriv_groups: Deriv[][] = [];
		{
			const groups = new Map<string, Deriv[]>();
			for (const d of derivs) {
				const key = `${d.xD}|${d.xB}|${d.imm}|${d.imm2}`;
				const g = groups.get(key);
				if (g) g.push(d);
				else groups.set(key, [d]);
			}
			for (const [, members] of groups) {
				const { xD, xB, imm } = members[0];
				const member_lines = new Set<number>();
				let defs = 0;
				for (const m of members) {
					for (let k = m.first_idx; k <= m.last_idx; k++) {
						member_lines.add(k);
						const c = parsed[k];
						if (!c) continue;
						const dest = c.operands[0];
						if (dest && dest.kind === "reg" && dest.name === xD) defs++;
					}
				}
				let ok = true;
				for (let k = headIdx + 1; k < end; k++) {
					if (member_lines.has(k)) continue;
					const c = parsed[k];
					if (!c) continue;
					const dest = c.operands[0];
					const dest_reg = dest && dest.kind === "reg" ? dest.name : "";
					if (dest_reg === xB || dest_reg === xD) {
						ok = false;
						break;
					}
					if (c.op === "add" || c.op === "adds") {
						if (
							c.operands.length === 3 &&
							c.operands[1].kind === "reg" &&
							c.operands[1].name === xB &&
							c.operands[2].kind === "imm"
						) {
							// An address escape of the base struct — its fields
							// are reachable through the derived register; refuse.
							ok = false;
							break;
						}
					}
					if (c.op === "str") {
						for (const o of c.operands) {
							if (
								o.kind === "mem" &&
								o.base === xB &&
								o.offset?.kind === "imm" &&
								o.offset.value.toString() === imm
							) {
								ok = false;
							}
						}
					}
				}
				if (ok) deriv_groups.push(members);
			}
		}

		// Write-slot carries take the promotion registers first (their
		// sync stores are the existing behavior); derivations next (2
		// instructions per iteration); read-only slots get the remainder
		// (no sync).
		const renames: { off: string; reg: string; sync: boolean }[] = [];
		let promo_idx = 0;
		for (const off of candidates) {
			if (promo_idx >= promo.length) break;
			renames.push({ off, reg: promo[promo_idx++], sync: true });
		}
		const deriv_renames: { members: Deriv[]; reg: string }[] = [];
		for (const members of deriv_groups) {
			if (promo_idx >= promo.length) break;
			deriv_renames.push({ members, reg: promo[promo_idx++] });
		}
		for (const off of readonly_candidates) {
			if (promo_idx >= promo.length) break;
			renames.push({ off, reg: promo[promo_idx++], sync: false });
		}
		if (renames.length === 0 && deriv_renames.length === 0) continue;
		for (let j = headIdx; j <= end; j++) owned.add(j);

		// Rename inside the cycle. Track per-slot promotions for syncs.
		for (let j = headIdx + 1; j < end; j++) {
			const instr = parsed[j];
			if (!instr) continue;
			if (instr.op !== "ldr" && instr.op !== "str") continue;
			const m = mem_slot(instr);
			if (!m || m.base !== "x29") continue;
			const rn = renames.find((r) => r.off === m.off);
			if (!rn) continue;
			const dst = instr.operands[0];
			if (dst.kind !== "reg") continue;
			const indent = lines[j].match(/^\s*/)?.[0] ?? "";
			out[j] =
				instr.op === "ldr"
					? `${indent}mov ${dst.name}, ${rn.reg}`
					: `${indent}mov ${rn.reg}, ${dst.name}`;
			// The carry-increment fold below pattern-matches the RENAMED
			// sequence — keep the parse in sync.
			parsed[j] = parse_asm_instruction(out[j], j + 1);
		}

		// Derivation renames: the sequence's lines become empty and every
		// remaining xD use in the cycle renames to the promotion register.
		// The rename is a whole-word text substitution on the line (out[]
		// is authoritative for unrenamed lines); parses are refreshed so
		// the carry-increment fold below sees the final text.
		for (const dr of deriv_renames) {
			const lines_of = new Set<number>();
			for (const m of dr.members) {
				for (let k = m.first_idx; k <= m.last_idx; k++) lines_of.add(k);
			}
			for (const k of lines_of) {
				out[k] = "";
				parsed[k] = null;
			}
			const word = new RegExp(`\\b${dr.members[0].xD}\\b`, "g");
			for (let j = headIdx + 1; j < end; j++) {
				if (lines_of.has(j)) continue;
				if (!out[j] || !out[j].includes(dr.members[0].xD)) continue;
				out[j] = out[j].replace(word, dr.reg);
				parsed[j] = parse_asm_instruction(out[j], j + 1);
			}
		}

		// Entry load before the header label (fall-through only) — all
		// renames' loads accumulate (a loop overwriting the line would
		// drop every load but the last, leaving the other registers
		// uninitialized). Derivation pairs re-emit their two-instruction
		// computation.
		const slot_entry = renames.map((rn) => `ldr ${rn.reg}, [x29, #${rn.off}]`);
		const deriv_entry = deriv_renames.map(
			(dr) =>
				`add ${dr.reg}, ${dr.members[0].xB}, #${dr.members[0].imm}\nldr ${dr.reg}, [${dr.reg}, #${dr.members[0].imm2}]`,
		);
		const entry_loads = [...slot_entry, ...deriv_entry].join("\n");
		if (entry_loads.length > 0) out[headIdx] = `${entry_loads}\n${lines[headIdx]}`;
		// Sync stores after each exit label — write-slot carries only.
		const synced = renames.filter((rn) => rn.sync);
		for (const [, exit_idx] of [...exits.entries()].sort((a, b) => b[1] - a[1])) {
			const stores = synced.map((rn) => `str ${rn.reg}, [x29, #${rn.off}]`).join("\n");
			out[exit_idx] = `${lines[exit_idx]}\n${stores}`;
		}

		// The carry-increment collapse: `cset xT, cc` … `add xA, xA, xT`
		// … `mov xH, xA`  ⇒  `cinc xH, xH, cc`, where xH is a promotion
		// register of this loop. The add may sit a few harmless
		// (non-flag-writing, unrelated-register) instructions after the
		// cset; the home's update may sit a few after the add. Removing
		// the cset is safe because nothing between it and the cinc writes
		// flags; removing the add is safe because xT's only reader was
		// the add and xA's only readers were the add and the home update.
		const is_harmless = (instr: AsmInstruction): boolean => {
			if (!instr) return false;
			if (
				instr.op === "b" ||
				instr.op.startsWith("b") ||
				instr.op === "bl" ||
				instr.op === "blr" ||
				instr.op === "br" ||
				instr.op === "ret" ||
				instr.op === "svc"
			)
				return false;
			if (instr.setsFlags) return false;
			if (instr.op === "cset" || instr.op === "cinc" || instr.op === "csel") return false;
			for (const o of instr.operands) {
				if (o.kind === "reg" && (o.name === xT_local || o.name === xA_local || o.name === xH_local))
					return false;
			}
			return true;
		};
		let xT_local = "";
		let xA_local = "";
		let xH_local = "";
		for (let j = headIdx + 1; j < end; j++) {
			const a = parsed[j];
			if (!a || a.op !== "cset" || a.operands.length !== 2) continue;
			if (a.operands[0].kind !== "reg" || a.operands[1].kind !== "cond") continue;
			xT_local = (a.operands[0] as { name: string }).name;
			xA_local = "";
			xH_local = "";
			const cc = (a.operands[1] as { code: string }).code;
			// Find the add within a small window.
			let add_idx = -1;
			let xA = "";
			for (let k = j + 1; k < Math.min(j + 7, end); k++) {
				const c = parsed[k];
				if (!c) {
					if (lines[k].trim().endsWith(":")) break;
					continue;
				}
				// The consumer add reads xT — match it BEFORE the harm
				// check (it is the one instruction allowed to touch xT).
				if (
					c.op === "add" &&
					c.operands.length === 3 &&
					c.operands[0].kind === "reg" &&
					c.operands[1].kind === "reg" &&
					c.operands[2].kind === "reg" &&
					(c.operands[0] as { name: string }).name === (c.operands[1] as { name: string }).name &&
					(c.operands[2] as { name: string }).name === xT_local
				) {
					add_idx = k;
					xA = (c.operands[0] as { name: string }).name;
					break;
				}
				if (!is_harmless(c)) break;
			}
			if (add_idx < 0) continue;
			// Find the home update: mov xH, xA with xH a promotion register.
			let home_idx = -1;
			let xH = "";
			for (let k = add_idx + 1; k < Math.min(add_idx + 16, end + 1); k++) {
				const d = parsed[k];
				if (!d) {
					if (lines[k].trim().endsWith(":")) break;
					continue;
				}
				// The home update reads xA — match it BEFORE the harm
				// check (it is the one instruction allowed to touch xA).
				if (
					d.op === "mov" &&
					d.operands.length === 2 &&
					d.operands[0].kind === "reg" &&
					d.operands[1].kind === "reg" &&
					(d.operands[1] as { name: string }).name === xA
				) {
					const cand = (d.operands[0] as { name: string }).name;
					if (renames.some((r) => r.reg === cand)) {
						home_idx = k;
						xH = cand;
						break;
					}
					// A non-home write of xA kills the add's value.
					break;
				}
				if (!is_harmless(d)) break;
			}
			if (home_idx < 0) continue;
			const indent = lines[j].match(/^\s*/)?.[0] ?? "";
			out[j] = `${indent}cinc ${xH}, ${xH}, ${cc}`;
			out[add_idx] = "";
			out[home_idx] = "";
		}
	}

	return out.join("\n");
}

/** Conditional branches in both spellings the backend emits: `b.hs` and
 *  the ARM32-style alias `bhs` (raw library blocks use both). */
function is_cond_branch(op: string): boolean {
	return (
		op.startsWith("b.") ||
		(op.length > 1 &&
			op[0] === "b" &&
			op !== "b" &&
			op !== "bl" &&
			op !== "blr" &&
			op !== "br" &&
			is_cond(op.slice(1)))
	);
}
