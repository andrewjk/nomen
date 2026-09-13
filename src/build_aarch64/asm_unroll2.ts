/**
 * ×2 loop unrolling in validated cycles (ASM_PLAN_7 tranche 8). The
 * asm-loop-promote model already validates the cycle shape; this pass
 * duplicates its body so the per-iteration guard overhead amortizes:
 *
 *     .while_N:                 (preguard)  cmp j, bound ; b.cond exit
 *       cmp j, bound                .while_N:
 *       b.cond .end_while_N           BODY-1   (body + j += m)
 *       BODY                          cmp j, bound ; b.cond exit
 *       j += m                        BODY-2   (body + j += m)
 *       b .while_N                    b .while_N
 *       .end_while_N:
 *
 * Soundness model:
 *
 * - The header label MOVES below the pre-guard: entry falls through the
 *   pre-guard (trip 0 exits there; trip ≥ 1 falls into BODY-1), and the
 *   back-edge re-enters at BODY-1 — where the duplicate guard before
 *   BODY-2 already priced the exit. Every guard instance is the ORIGINAL
 *   guard text evaluated at the same sequential points as before: after
 *   0 increments (pre-guard) and after each single increment (mid-loop).
 *   Trip counts 0, 1, odd, and even all execute the same bodies with the
 *   same j values as the original, in the same order — both copies keep
 *   their own `j += m`, so j's final value is bit-identical for every
 *   trip count.
 * - The body is straight-line by validation: no calls, no indirect
 *   transfers, no jump-TARGETED label inside (an inner diamond would
 *   duplicate its labels and let copy-2 skip copy-1's increments). A
 *   second mid-body EXIT (conditional branch targeting outside) is fine —
 *   each copy exits on its own condition, truncating the iteration
 *   sequence exactly as the original did. Untargeted markers
 *   (`.while_update_N:`, unreferenced numeric labels) are dropped from
 *   the duplicate — duplicate label definitions are assembler errors,
 *   and a marker positions nothing.
 * - The duplicate guard's flags come from its own adjacent cmp (labels
 *   reset known flags; the lift re-validates the whole text, and any
 *   validation failure reverts the candidate).
 *
 * Runs AFTER pointer-walk strength reduction, so both copies carry every
 * earlier transform. Kill-switch: `set_loop2_unroll_enabled(false)`
 * returns the text unchanged (byte-identical off arm).
 */

import { build_tables } from "./asm_remat.ts";
import { validate_asm } from "./lift_asm.ts";

let unroll2_on = true;

export function loop2_unroll_enabled(): boolean {
	return unroll2_on;
}

export function set_loop2_unroll_enabled(enabled: boolean): void {
	unroll2_on = enabled;
}

const NUMERIC_RE = /^\d+$/;
const LABEL_LINE_RE = /^([A-Za-z_.$][\w.$]*|\d+):$/;
const MAX_BODY = 30;

/** Find the header line of the first unrollable cycle, or null. */
function find_unroll_one(lines: string[], done: Set<string>): number | null {
	const { parsed, labels, jumps } = build_tables(lines.join("\n"));

	const targeted = new Set<number>();
	for (const j of jumps) {
		if (j.target !== null) targeted.add(j.target);
	}

	for (const [name, positions] of labels) {
		if (positions.length !== 1 || NUMERIC_RE.test(name)) continue;
		if (done.has(name)) continue;
		const h = positions[0];
		// The back-edge: unconditional jump to h from below.
		let e = -1;
		for (const j of jumps) {
			if (j.target === h && !j.cond && j.from > h) {
				e = j.from;
				break;
			}
		}
		if (e === -1) continue;

		// Validate the cycle: straight-line (no calls/exits/indirect
		// transfers), no jump-targeted inner label, size cap.
		let ok = true;
		let body_len = 0;
		for (let k = h + 1; k < e && ok; k++) {
			if (targeted.has(k)) ok = false;
			const c = parsed[k];
			if (!c) continue;
			body_len++;
			if (c.op === "bl" || c.op === "blr" || c.op === "br" || c.op === "ret" || c.op === "svc") {
				ok = false;
			}
		}
		if (!ok || body_len === 0 || body_len > MAX_BODY) continue;

		// Guard shape: the two lines after the header label are
		// `cmp …` + `b.cond exit`, with the branch target outside the
		// cycle (the while-dispatch's fixed emission).
		const guard_cmp = parsed[h + 1];
		const guard_br = parsed[h + 2];
		if (
			!guard_cmp ||
			guard_cmp.op !== "cmp" ||
			!guard_br ||
			!guard_br.op.startsWith("b.") ||
			h + 2 >= e
		) {
			continue;
		}
		const br_target = guard_br.operands[guard_br.operands.length - 1];
		if (!br_target || br_target.kind !== "label") continue;
		const resolved = resolve_label(labels, br_target.name, h + 2);
		if (resolved === null || (resolved > h && resolved < e)) continue;

		return h;
	}
	return null;
}

function resolve_label(labels: Map<string, number[]>, token: string, from: number): number | null {
	const m = /^(\d+)([fb])$/.exec(token);
	if (m) {
		const ps = labels.get(m[1]);
		if (!ps) return null;
		if (m[2] === "f") {
			for (const p of ps) if (p > from) return p;
			return null;
		}
		for (let k = ps.length - 1; k >= 0; k--) if (ps[k] < from) return ps[k];
		return null;
	}
	const ps = labels.get(token);
	return ps && ps.length > 0 ? ps[0] : null;
}

/** Apply the ×2 unroll at header line `h`. */
function apply_unroll(lines: string[], h: number): string | null {
	const { jumps } = build_tables(lines.join("\n"));
	let e = -1;
	for (const j of jumps) {
		if (j.target === h && !j.cond && j.from > h) {
			e = j.from;
			break;
		}
	}
	if (e === -1) return null;

	const guard = lines.slice(h + 1, h + 3); // cmp + b.cond
	const body = lines.slice(h + 3, e); // body + update marker + increment
	const body_dup: string[] = [];
	for (const line of body) {
		const t = line.trim();
		if (LABEL_LINE_RE.exec(t)) continue; // untargeted marker: drop in the copy
		if (!t || t.startsWith("//") || t.startsWith(".")) {
			body_dup.push(line); // directives/blanks ride along verbatim
			continue;
		}
		body_dup.push(line);
	}

	const out = lines.slice();
	// Pre-guard before the header label (the label ends up directly
	// before BODY-1; the back-edge re-enters there, past the pre-guard).
	out.splice(h, 0, ...guard);
	const e2 = e + guard.length;
	// Second copy right before the back-edge: guard first (pricing the
	// exit), then the duplicated body.
	out.splice(e2, 0, ...guard, ...body_dup);
	return out.join("\n");
}

/**
 * Phase entry — unroll each eligible validated cycle once (≤ 8 rounds;
 * a cycle's label name unrolls at most once).
 */
export function unroll_loops_x2(code: string): string {
	if (!unroll2_on) return code;
	const done = new Set<string>();
	for (let round = 0; round < 8; round++) {
		const lines = code.split("\n");
		const h = find_unroll_one(lines, done);
		if (h === null) break;
		const name = (LABEL_LINE_RE.exec(lines[h].trim())?.[1] ?? "").trim();
		const next = apply_unroll(lines, h);
		if (next === null) break;
		if (validate_asm(next).length > 0) break; // never ship a broken rewrite
		if (name) done.add(name);
		code = next;
	}
	return code;
}
