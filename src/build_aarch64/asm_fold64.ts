/**
 * 64-bit arithmetic folds (PERF_PLAN item 15 — the FOLLOWUP.md trio): the
 * three pure-Nomen 64-bit arithmetic codegen gaps the `Random.next` receipt
 * measured (~40 emitted instructions vs ~14 in a hand-written raw `#arch`
 * body). Splitmix64 is pure Nomen — bit-identical on both backends — and it
 * generalizes: every pure-Nomen 64-bit math site pays the same three taxes.
 *
 * 1. Immediate shift counts. `z >> 30` materializes the count as a value
 *    (`mov xR, #30`) and shifts by the register (`lsr xD, xS, xR`); the
 *    hardware takes a 6-bit immediate. The pair folds to `lsr xD, xS, #30`
 *    when the count materialization directly feeds the shift: consecutive
 *    instructions (blank/comment lines between are fine — labels are not),
 *    the count register is the mov's only product, and when the shift's
 *    destination differs from the count register a forward scan proves the
 *    count register is redefined before anything reads it (the deleted mov's
 *    value must be unobservable). xR == xD needs no scan: the shift reads its
 *    count operand at instruction start, so the destination's redefinition
 *    cannot shadow it — the common emitter shape (`mov x0, #30; lsr x0,
 *    x12, x0`).
 * 2. Field-value forwarding. `self.state = …; var z = self.state` stores the
 *    field and then reloads the same slot through a re-derived receiver
 *    (`str xV, [xS, #K] / mov xT, xS / ldr xD, [xT, #K]`). When nothing but
 *    blank lines sits between the store and the reload, the slot holds
 *    exactly xV's value — the reload forwards to `mov xD, xV` (deleted when
 *    xD == xV, the repro's shape). A `bl` in the window could mutate the
 *    field or clobber xV, so only the blank-window shapes fold.
 * 3. Constant materialization. Each 64-bit literal expands to a
 *    `movz`/`movn` + up to three `movk` chunk chain (4 instructions — the
 *    expand pass's deliberate replacement for `ldr xN, =K`, whose
 *    assembler-sited pool falls out of the ±1 MB literal reach in multi-MB
 *    programs). A full-width chain (two or more `movk` links) rewrites to
 *    ONE pc-relative literal load, `ldr xN, .LC64_N`, whose pool entry is a
 *    `.quad` emitted right after the function's final `ret` — adjacent, so
 *    the ±1 MB reach can never overflow, and after a `ret`, so no
 *    fall-through ever executes the data bytes. Values are deduplicated per
 *    pool and emitted as signed decimal (a ≥ 2^63 pattern overflows a
 *    unsigned .quad literal).
 *
 * Runs in build.ts AFTER expand_large_mov_immediates (the chunk chains exist
 * only after it) and expand_far_adr_addresses, BEFORE the lift/validator —
 * the `ldr xN, LABEL` literal form is a contracted shape in asm_ir.ts.
 * Every fold is semantics-preserving by construction; the kill-switch
 * (`set_fold64_enabled(false)`) returns the text unchanged (byte-identical
 * off arm).
 */

import { exact_defs, reads_of } from "./asm_cycle_dead_moves.ts";
import type { AsmInstruction } from "./asm_ir.ts";
import { parse_asm_instruction } from "./lift_asm.ts";

let fold64_on = true;

export function fold64_enabled(): boolean {
	return fold64_on;
}

export function set_fold64_enabled(enabled: boolean): void {
	fold64_on = enabled;
}

const MASK64 = (1n << 64n) - 1n;
const MASK16 = 0xffffn;

/** The chunk-chain forms expand_large_mov_immediates emits (decimal
 *  immediates, `lsl` chunk position on every movk link). The operand parser
 *  absorbs the `lsl` qualifier into the immediate, so the bit position is
 *  re-extracted from the text. */
const MOVZ_RE = /^(\s*)movz (x\d+|w\d+), #(\d+)$/;
const MOVN_RE = /^(\s*)movn (x\d+|w\d+), #(\d+)$/;
const MOVK_RE = /^(\s*)movk (x\d+|w\d+), #(\d+), lsl #(\d+)$/;

const INDENT_RE = /^\s*/;

type LineKind = "instr" | "blank" | "hard";

function classify(lines: string[]): {
	parsed: (AsmInstruction | null)[];
	kind: LineKind[];
} {
	const parsed: (AsmInstruction | null)[] = Array.from({ length: lines.length }, () => null);
	const kind: LineKind[] = Array.from({ length: lines.length }, () => "blank");
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i].trim();
		if (t === "" || t.startsWith("//")) {
			kind[i] = "blank";
			parsed[i] = null;
		} else if (t.startsWith(".") || t.endsWith(":") || /^[\w.$]+\s*=\s*[\w.$]+$/.test(t)) {
			// Label, directive, or alias: a control-flow/data boundary no
			// fold may cross.
			kind[i] = "hard";
			parsed[i] = null;
		} else {
			parsed[i] = parse_asm_instruction(lines[i], i + 1);
			kind[i] = parsed[i] ? "instr" : "hard";
		}
	}
	return { parsed, kind };
}

/** The next line after `from` that is anything but blank/comment — the
 *  fold shapes require straight-line adjacency, and this is the nearest
 *  candidate (an instruction or a hard boundary). -1 at the end. */
function next_meaningful(kind: LineKind[], from: number): number {
	for (let k = from + 1; k < kind.length; k++) {
		if (kind[k] === "blank") continue;
		return k;
	}
	return -1;
}

function is_branch_op(op: string): boolean {
	if (op === "b" || op === "cbz" || op === "cbnz" || op === "tbz" || op === "tbnz") return true;
	if (op.startsWith("b.")) return true;
	return /^b(eq|ne|lt|le|gt|ge|hs|lo|ls|hi|mi|pl)$/.test(op);
}

/** Whether `reg` is redefined before anything reads it, scanning forward
 *  from `from`. A control-flow boundary (label, branch, call, ret) refuses —
 *  the scan is deliberately local, no CFG. Never true at the end of text. */
function dead_until_redefined(
	parsed: (AsmInstruction | null)[],
	kind: LineKind[],
	from: number,
	reg: string,
): boolean {
	for (let k = from; k < parsed.length; k++) {
		if (kind[k] === "blank") continue;
		if (kind[k] !== "instr") return false;
		const instr = parsed[k]!;
		if (is_branch_op(instr.op) || instr.op === "bl" || instr.op === "blr" || instr.op === "ret") {
			return false;
		}
		if (reads_of(instr).includes(reg)) return false;
		if (exact_defs(instr).includes(reg)) return true;
	}
	return false;
}

/** Fold 1 — `mov xR, #N` + `lsl/lsr/asr xD, xS, xR` → the immediate form.
 *  Returns whether anything changed. */
function fold_immediate_shifts(
	lines: string[],
	parsed: (AsmInstruction | null)[],
	kind: LineKind[],
): boolean {
	let changed = false;
	for (let i = 0; i < lines.length; i++) {
		const mov = parsed[i];
		if (!mov || mov.op !== "mov" || mov.operands.length !== 2) continue;
		const [dst, imm] = mov.operands;
		if (dst.kind !== "reg" || imm.kind !== "imm") continue;
		if (!/^(x|w)\d+$/.test(dst.name)) continue;
		const n = imm.value;
		if (n < 0n || n > 63n) continue;
		const j = next_meaningful(kind, i);
		if (j === -1) continue;
		const shift = parsed[j];
		if (!shift || !["lsl", "lsr", "asr"].includes(shift.op)) continue;
		if (shift.operands.length !== 3) continue;
		const [s_dst, s_src, s_cnt] = shift.operands;
		if (s_dst.kind !== "reg" || s_src.kind !== "reg" || s_cnt.kind !== "reg") continue;
		if (s_cnt.name !== dst.name) continue;
		if (s_src.name === dst.name) continue; // the mov feeds the DATA path too
		// Immediate shift amounts: 6 bits for a 64-bit destination, 5 for
		// a 32-bit one — out of range keeps the register form.
		if (n > (s_dst.name.startsWith("x") ? 63n : 31n)) continue;
		// A count register the shift does not redefine must be provably
		// dead after the shift (no reader observes the deleted mov).
		if (s_dst.name !== dst.name && !dead_until_redefined(parsed, kind, j + 1, dst.name)) {
			continue;
		}
		const indent = lines[i].match(INDENT_RE)?.[0] ?? "";
		lines[i] = "";
		lines[j] = `${indent}${shift.op} ${s_dst.name}, ${s_src.name}, #${n}`;
		changed = true;
	}
	return changed;
}

/** Fold 2 — a store to `[xS, #K]` followed (across blank lines only) by the
 *  same slot's reload forwards the stored register. The reload may re-derive
 *  the receiver first (`mov xT, xS`). Returns whether anything changed. */
function forward_field_stores(
	lines: string[],
	parsed: (AsmInstruction | null)[],
	kind: LineKind[],
): boolean {
	let changed = false;
	for (let i = 0; i < lines.length; i++) {
		const st = parsed[i];
		if (!st || st.op !== "str" || st.operands.length !== 2) continue;
		const [val, mem] = st.operands;
		if (val.kind !== "reg" || mem.kind !== "mem") continue;
		if (!/^(x|w)\d+$/.test(val.name) || val.name === "xzr" || val.name === "wzr") continue;
		if (mem.scale !== undefined || mem.writeback !== undefined || mem.postOffset !== undefined) {
			continue;
		}
		if (!mem.offset || mem.offset.kind !== "imm") continue;
		if (mem.base !== "sp" && !/^(x|w)\d+$/.test(mem.base)) continue;
		const off = mem.offset.value;
		const j = next_meaningful(kind, i);
		if (j === -1) continue;
		// Optional receiver re-derivation between the store and the reload.
		let ldr_idx = j;
		let addr_base = mem.base;
		const between = parsed[j];
		if (
			between &&
			between.op === "mov" &&
			between.operands.length === 2 &&
			between.operands[0].kind === "reg" &&
			between.operands[1].kind === "reg" &&
			between.operands[1].name === mem.base &&
			/^(x|w)\d+$/.test(between.operands[0].name) &&
			between.operands[0].name !== "xzr" &&
			between.operands[0].name !== "wzr"
		) {
			const j2 = next_meaningful(kind, j);
			if (j2 === -1) continue;
			ldr_idx = j2;
			addr_base = between.operands[0].name;
		}
		const ld = parsed[ldr_idx];
		if (!ld || ld.op !== "ldr" || ld.operands.length !== 2) continue;
		const [dst, lmem] = ld.operands;
		if (dst.kind !== "reg" || lmem.kind !== "mem") continue;
		if (!/^(x|w)\d+$/.test(dst.name) || dst.name === "xzr" || dst.name === "wzr") continue;
		if (lmem.base !== addr_base) continue;
		if (lmem.scale !== undefined || lmem.writeback !== undefined || lmem.postOffset !== undefined) {
			continue;
		}
		if (!lmem.offset || lmem.offset.kind !== "imm" || lmem.offset.value !== off) continue;
		// Width match: an x-store forwards to an x-reload, a w-store to a
		// w-reload (the zero-extension discipline is identical).
		if (val.name[0] !== dst.name[0]) continue;
		const indent = lines[j].match(INDENT_RE)?.[0] ?? "";
		const replacement = dst.name === val.name ? "" : `${indent}mov ${dst.name}, ${val.name}`;
		if (ldr_idx === j) {
			lines[j] = replacement;
		} else {
			lines[j] = "";
			lines[ldr_idx] = replacement;
		}
		changed = true;
	}
	return changed;
}

/** One detected chunk chain: lines [head, tail], all `reg`, materializing
 *  the 64-bit pattern `value` (two's-complement bits). */
interface Chain {
	head: number;
	tail: number;
	reg: string;
	value: bigint;
	movk_count: number;
}

function find_chains(lines: string[]): Chain[] {
	const chains: Chain[] = [];
	for (let i = 0; i < lines.length; i++) {
		const zm = MOVZ_RE.exec(lines[i]);
		const nm = zm ? null : MOVN_RE.exec(lines[i]);
		if (!zm && !nm) continue;
		const m = zm ?? nm;
		const reg = m![2];
		let value = BigInt(m![3]);
		if (!zm) value = ~value & MASK64; // movn heads invert the 16-bit field
		let tail = i;
		let movk_count = 0;
		let expected_shift = 16;
		let k = i + 1;
		while (k < lines.length) {
			const km = MOVK_RE.exec(lines[k]);
			if (!km) {
				const t = lines[k].trim();
				if (t === "" || t.startsWith("//")) {
					k++;
					continue;
				}
				break;
			}
			if (km[2] !== reg) break;
			const shift = Number(km[4]);
			if (shift !== expected_shift) break;
			value = (value & ~(MASK16 << BigInt(shift))) | (BigInt(km[3]) << BigInt(shift));
			expected_shift += 16;
			tail = k;
			movk_count++;
			k++;
		}
		// Only the full-width chains the item targets — a lone movk link is
		// 2 instructions and pooling it would grow the text (an 8-byte pool
		// word for one instruction saved).
		if (movk_count < 2) continue;
		chains.push({ head: i, tail, reg, value: value & MASK64, movk_count });
		i = tail;
	}
	return chains;
}

/** The function-final `ret` at or after `from` — the pool's insertion
 *  point. A `ret` terminates execution, so data bytes after it are never
 *  fallen into; a ret followed by a dot-local label (`.return_0:`) is not
 *  the function's last word, so the scan continues. -1 when none is found. */
function final_ret_after(lines: string[], from: number): number {
	for (let k = from; k < lines.length; k++) {
		if (lines[k].trim() !== "ret") continue;
		let m = k + 1;
		while (m < lines.length) {
			const t = lines[m].trim();
			if (t === "" || t.startsWith("//")) {
				m++;
				continue;
			}
			break;
		}
		if (m >= lines.length) return k;
		const t = lines[m].trim();
		if (t.endsWith(":") && t.startsWith(".")) continue; // local label: more function follows
		return k;
	}
	return -1;
}

/** Guard for the pathological scan-past-the-function case (a function whose
 *  body never rets): the pc-relative literal reach is ±1 MB, and the pool
 *  must sit within it of every load it serves. 100k lines of worst-case
 *  8-byte instructions stays comfortably inside. */
const MAX_POOL_DISTANCE_LINES = 100_000;

function pool_chains(lines: string[], chains: Chain[]): boolean {
	if (chains.length === 0) return false;
	const pools = new Map<number, Map<bigint, string>>(); // ret line → value → label
	let label_counter = 0;
	let folded = 0;
	for (const c of chains) {
		const ret = final_ret_after(lines, c.tail);
		if (ret === -1 || ret - c.head > MAX_POOL_DISTANCE_LINES) continue;
		let by_value = pools.get(ret);
		if (!by_value) {
			by_value = new Map();
			pools.set(ret, by_value);
		}
		let label = by_value.get(c.value);
		if (label === undefined) {
			label = `.LC64_${label_counter++}`;
			by_value.set(c.value, label);
		}
		const indent = lines[c.head].match(INDENT_RE)?.[0] ?? "";
		lines[c.head] = `${indent}ldr ${c.reg}, ${label}`;
		for (let k = c.head + 1; k <= c.tail; k++) lines[k] = "";
		folded++;
	}
	if (folded === 0) return false;
	// Insert the pools (descending so earlier splices keep later indexes).
	const rets = [...pools.keys()].sort((a, b) => b - a);
	for (const ret of rets) {
		const block: string[] = [];
		for (const [value, label] of pools.get(ret)!) {
			// ≥ 2^63 patterns go out signed — an unsigned .quad literal
			// overflows the assembler's range check.
			const signed = value >= 1n << 63n ? value - (1n << 64n) : value;
			block.push(`\t${label}:`);
			block.push(`\t.quad ${signed}`);
		}
		lines.splice(ret + 1, 0, ...block);
	}
	return true;
}

/** The tranche entry point: all three folds, kill-switchable. */
export function fold_64bit_arithmetic(code: string): string {
	if (!fold64_on) return code;
	const lines = code.split("\n");
	{
		const { parsed, kind } = classify(lines);
		fold_immediate_shifts(lines, parsed, kind);
	}
	{
		const { parsed, kind } = classify(lines);
		forward_field_stores(lines, parsed, kind);
	}
	pool_chains(lines, find_chains(lines));
	return lines.join("\n");
}
