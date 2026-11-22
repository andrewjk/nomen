/**
 * Two contained float-side peepholes over lifted assembly, motivated by the
 * mandelbrot escape check — a scalar min-reduction (`s = x*x + y*y;
 * if s < acc { acc = s }`) emitted FOUR loads for two (the duplicated
 * `x.load_float(l)` / `y.load_float(l)` operands had no CSE on the
 * non-peeled path) and a branchy three-instruction select:
 *
 * 1. Duplicate-FPR-load elimination — within a straight-line region, a
 *    `ldr dN/sN, <mem>` whose <mem> was already loaded into a still-valid
 *    register (no intervening def of that register or of any address
 *    register in <mem>, no non-frame store, no label, no call) is deleted
 *    (same destination) or rewritten to `fmov dN, dM` (different one).
 *    Frame stores ([x29]/[sp]) are call-private (the asm_opt soundness
 *    model) and keep records alive; every other store clears them.
 *
 * 2. Float conditional-select conversion — `fcmp fA, fB` + `b.<cc> L` +
 *    exactly one `fmov dC, dD` + `L:` becomes `fcmp fA, fB` + `fcsel dC,
 *    dD, dC, <!cc>`, provided L has no other reference in the function (a
 *    join would skip the select and read a stale dC). fcsel is
 *    semantics-identical to the branch form: a NaN compare takes the false
 *    arm both ways (unordered → condition false → keep dC; branch → skip
 *    the move), and ±0 compares as equal both ways.
 *
 * Both passes are straight-line only (labels clear every record) and OFF
 * restores the untransformed text byte-identically.
 */

import type { AsmInstruction, Operand } from "./asm_ir.ts";
import { is_alias_line, reg_class } from "./asm_ir.ts";
import { parse_asm_instruction } from "./lift_asm.ts";

/** Registers an instruction WRITES — the destination register(s).
 *  Stores, compares, and branches write nothing; bl/blr are handled by the
 *  callers as whole-set clobbers. Deliberately conservative: an unknown op
 *  contributes its first register operand (the conventional destination). */
function defs_of(instr: AsmInstruction): string[] {
	const op = instr.op;
	if (
		op === "str" ||
		op === "stur" ||
		op === "strb" ||
		op === "strh" ||
		op === "stp" ||
		op === "cmp" ||
		op === "tst" ||
		op === "cmn" ||
		op === "fcmp" ||
		op === "ret" ||
		op.startsWith("b.") ||
		op === "b" ||
		op === "cbz" ||
		op === "cbnz" ||
		op === "tbz" ||
		op === "tbnz"
	) {
		return [];
	}
	if (op === "ldp") {
		const out: string[] = [];
		for (const o of instr.operands.slice(0, 2)) {
			if (o.kind === "reg") out.push(o.name);
		}
		return out;
	}
	for (const o of instr.operands) {
		if (o.kind === "reg") return [o.name];
		if (o.kind === "mem" || o.kind === "cond") return [];
	}
	return [];
}

const CALLER_SAVED: string[] = [];
for (let i = 0; i <= 17; i++) {
	CALLER_SAVED.push(`x${i}`, `w${i}`);
}
for (let i = 0; i <= 7; i++) {
	CALLER_SAVED.push(`d${i}`, `s${i}`);
}

/** Canonical text for a plain memory operand plus the GPRs its address
 *  reads. `null` for forms the duplicate-load pass must not key on
 *  (writeback moves the base; pc-relative and literal forms are not
 *  repeatable data loads). */
function mem_info(mem: Operand): { key: string; addrs: string[] } | null {
	if (mem.kind !== "mem" || mem.writeback) return null;
	if (mem.postOffset !== undefined) return null;
	const parts: string[] = [mem.base];
	const addrs: string[] = [mem.base];
	if (mem.offset !== undefined) {
		if (mem.offset.kind === "imm") {
			parts.push(`#${mem.offset.value}`);
		} else {
			parts.push(mem.offset.name);
			addrs.push(mem.offset.name);
		}
	}
	if (mem.scale !== undefined) {
		parts.push(`lsl #${mem.scale}`);
	}
	return { key: `[${parts.join(", ")}]`, addrs };
}

function is_frame_base(base: string): boolean {
	return base === "x29" || base === "sp" || base === "fp";
}

/** The physical storage a register name views: d/s/q are all views of one
 *  AArch64 vector register (`v0.2d` is v0's 128 bits; d5/s5 its low 64/32),
 *  and wN writes xN's low half. Any def of ANY view invalidates records in
 *  ANY view of the same storage — conservatively for the lane/arrangement
 *  forms, where a partial write still stale-dates the wider views. */
function reg_family(name: string): string {
	const v = /^([dsqv])(\d+)/.exec(name);
	if (v) return `v${v[2]}`;
	const g = /^(x|w)(\d+)$/.exec(name);
	if (g) return `x${g[2]}`;
	return name; // sp / fp / lr / xzr
}

// ── pass 1: duplicate FPR-load elimination ──────────────────────────────────

let dup_load_cse_on = true;

export function set_dup_load_cse_enabled(enabled: boolean): void {
	dup_load_cse_on = enabled;
}

export function duplicate_load_cse_enabled(): boolean {
	return dup_load_cse_on;
}

interface LoadRecord {
	/** Canonical memory-operand key, prefixed by the load width (an s-load
	 *  does not satisfy a d-load, nor a d a q). */
	key: string;
	/** The physical vector storage holding the loaded value (vN). */
	fam: string;
	/** The holding register's emitted name (for the fmov rewrite). */
	reg: string;
	/** Address families the key reads — a def of any of them changes the
	 *  address. */
	addrFams: string[];
}

export function eliminate_duplicate_fpr_loads(code: string): string {
	if (!dup_load_cse_on) return code;
	const lines = code.split("\n");
	const out: string[] = [];
	let recs: LoadRecord[] = [];

	const drop_where = (pred: (r: LoadRecord) => boolean): void => {
		recs = recs.filter((r) => !pred(r));
	};
	const drop_reg = (reg: string): void => {
		const fam = reg_family(reg);
		drop_where((r) => r.fam === fam || r.addrFams.includes(fam));
	};

	for (let i = 0; i < lines.length; i++) {
		const text = lines[i];
		const trimmed = text.trim();
		if (!trimmed || trimmed.startsWith("//")) {
			out.push(text);
			continue;
		}
		const label_m = /^([A-Za-z_.$][\w.$]*):/.exec(trimmed);
		if (label_m || trimmed.startsWith(".") || is_alias_line(trimmed)) {
			// Label: join point — the fall-through provenance does not apply.
			recs = [];
			out.push(text);
			continue;
		}
		const instr = parse_asm_instruction(text, i + 1);
		if (!instr) {
			recs = [];
			out.push(text);
			continue;
		}
		const op = instr.op;

		// The pattern: an FPR load. A hit rewrites or deletes the load; a
		// miss records it.
		if ((op === "ldr" || op === "ldur") && instr.operands.length === 2) {
			const dst = instr.operands[0];
			if (dst.kind === "reg" && reg_class(dst.name) === "fpr") {
				const mem = mem_info(instr.operands[1]);
				if (mem !== null) {
					// The record's width is part of the key: an s-load (32
					// bits) does not satisfy a d-load (64), nor a d a q (128).
					const key = `${dst.name[0]}${mem.key}`;
					const hit = recs.find((r) => r.key === key);
					if (hit !== undefined) {
						const indent = text.match(/^\s*/)?.[0] ?? "";
						if (hit.reg === dst.name) {
							// Destination still holds the value: the load is a
							// pure no-op. Delete it.
							continue;
						}
						// The rewrite defines dst — its old records die with it.
						drop_reg(dst.name);
						// Width-appropriate register move: fmov encodes d/s
						// forms; a 128-bit q-form load moves via the vector
						// `mov vN.16b` alias (fmov has no q operands).
						const is_q = dst.name.startsWith("q") || hit.reg.startsWith("q");
						const mv = is_q
							? `mov v${dst.name.slice(1)}.16b, v${hit.reg.slice(1)}.16b`
							: `fmov ${dst.name}, ${hit.reg}`;
						out.push(`${indent}${mv}`);
						continue;
					}
					recs.push({
						key,
						fam: reg_family(dst.name),
						reg: dst.name,
						addrFams: mem.addrs.map(reg_family),
					});
					out.push(text);
					continue;
				}
			}
		}

		if (op === "bl" || op === "blr" || op === "svc") {
			// The callee may write any heap memory (and clobbers the
			// caller-saved FPRs the records hold).
			recs = [];
			out.push(text);
			continue;
		}
		if (op === "str" || op === "stur" || op === "strb" || op === "strh" || op === "stp") {
			const mem = instr.operands.length >= 2 ? instr.operands[1] : undefined;
			if (mem === undefined || mem.kind !== "mem" || !is_frame_base(mem.base)) {
				// A non-frame store may alias any heap address.
				recs = [];
				out.push(text);
				continue;
			}
			// Frame-slot store: call-private, cannot touch heap loads.
			out.push(text);
			continue;
		}
		for (const d of defs_of(instr)) drop_reg(d);
		out.push(text);
	}

	return out.join("\n");
}

// ── pass 2: float conditional-select conversion ─────────────────────────────

let float_select_on = true;

export function set_float_select_enabled(enabled: boolean): void {
	float_select_on = enabled;
}

export function float_select_enabled(): boolean {
	return float_select_on;
}

/** Skip-branch condition → the fcsel condition that assigns on the
 *  branch-not-taken path (the exact FP-condition inverses: MI↔PL, GT↔LE,
 *  GE↔LT, EQ↔NE, VS↔VC). */
const INVERT_CC: Record<string, string> = {
	mi: "pl",
	pl: "mi",
	gt: "le",
	le: "gt",
	ge: "lt",
	lt: "ge",
	eq: "ne",
	ne: "eq",
	vs: "vc",
	vc: "vs",
};

export function convert_float_selects(code: string): string {
	if (!float_select_on) return code;
	const lines = code.split("\n");

	// Global label reference counts: a convertible diamond's target must be
	// referenced exactly twice (the definition + this branch). Any other
	// jump into it would bypass the rewritten select.
	const refs = new Map<string, number>();
	for (const text of lines) {
		const instr = parse_asm_instruction(text, 1);
		if (!instr) continue;
		if (instr.op.startsWith("b.") || instr.op === "cbz" || instr.op === "cbnz") {
			const last = instr.operands[instr.operands.length - 1];
			if (last.kind === "label") {
				refs.set(last.name, (refs.get(last.name) ?? 0) + 1);
			}
		}
	}

	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const text = lines[i];
		const trimmed = text.trim();
		if (!trimmed || trimmed.startsWith("//")) {
			out.push(text);
			continue;
		}
		const instr = parse_asm_instruction(text, i + 1);
		if (instr && instr.op === "fcmp" && i + 3 < lines.length) {
			const cmp_ops = instr.operands;
			const branch = parse_asm_instruction(lines[i + 1], i + 2);
			const move = parse_asm_instruction(lines[i + 2], i + 3);
			const label_line = lines[i + 3].trim();
			const branch_m = branch && /^b\.[a-z]{2}$/.test(branch.op) ? branch : undefined;
			const cc = branch_m !== undefined ? branch_m.op.slice(2) : "";
			const inv = INVERT_CC[cc];
			const label_name = branch_m !== undefined ? branch_m.operands[0] : undefined;
			const move_ok =
				move &&
				move.op === "fmov" &&
				move.operands.length === 2 &&
				move.operands.every((o) => o.kind === "reg" && reg_class(o.name) === "fpr");
			if (
				cmp_ops.length === 2 &&
				cmp_ops.every((o) => o.kind === "reg" && reg_class(o.name) === "fpr") &&
				inv !== undefined &&
				label_name !== undefined &&
				label_name.kind === "label" &&
				move_ok &&
				label_line === `${label_name.name}:` &&
				(refs.get(label_name.name) ?? 0) === 1
			) {
				const indent = text.match(/^\s*/)?.[0] ?? "";
				const dst = (move!.operands[0] as { name: string }).name;
				const src = (move!.operands[1] as { name: string }).name;
				out.push(text);
				out.push(`${indent}fcsel ${dst}, ${src}, ${dst}, ${inv}`);
				// Skip the branch, the assignment, and the now-unreferenced
				// target label (its only reference was this branch).
				i += 3;
				continue;
			}
		}
		out.push(text);
	}

	return out.join("\n");
}
