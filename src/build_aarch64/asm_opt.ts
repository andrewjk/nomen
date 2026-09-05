/**
 * Phase-2 dataflow optimization over lifted assembly: frame-slot forwarding
 * and dead-store elimination, per basic block.
 *
 * Soundness model:
 *
 * - `[x29, #N]` frame slots are private to the function. Callees cannot
 *   touch them except through ref/sret marshalling, which visibly emits an
 *   `add xN, x29` address first — any x29-derived address that is not the
 *   normalize idiom is treated as an ESCAPE (all knowledge dropped).
 * - Every instruction declares the registers it DEFINES via `instr_defs`,
 *   and defining a register (a) materializes pending stores sourced from it
 *   (their value would otherwise be lost) and (b) invalidates availability
 *   held in it (width siblings included). Calls define the entire
 *   caller-saved set.
 * - Labels and branches are block boundaries: pending stores materialize
 *   before them (join points may read).
 * - Forwarding requires an exact family+width match between store and load;
 *   mismatched accesses materialize the pending store instead.
 *
 * Deliberately NOT here: stack-balance checking (needs real CFG analysis),
 * cross-block optimization (join semantics).
 */

import type { AsmInstruction } from "./asm_ir.ts";
import { reg_class } from "./asm_ir.ts";
import { parse_asm_instruction } from "./lift_asm.ts";

interface SlotState {
	/** Unemitted store: text + access key + source register. */
	pendKey?: string;
	pendText?: string;
	pendReg?: string;
	/** Register currently holding this slot's value, if known. */
	availReg?: string;
	/** Access family+width the availability was established with —
	 *  coalescing across widths is unsound (`mov` zero-extends; `ldr x`
	 *  reads all 64 bits). */
	availKey?: string;
}

const CALLER_SAVED: string[] = [];
for (let i = 0; i <= 17; i++) {
	CALLER_SAVED.push(`x${i}`, `w${i}`);
}
for (let i = 0; i <= 7; i++) {
	CALLER_SAVED.push(`d${i}`, `s${i}`);
}

/** Ops whose register operands are ALL reads (no destination register):
 *  branch/test and call-target forms — their operand must count as live
 *  (a `mov x9, …` feeding `cbz x9` is load-bearing). */
const READ_ONLY_REG_OPS = new Set(["blr", "br", "cbz", "cbnz", "tbz", "tbnz"]);

function sibling_reg(name: string): string | null {
	if (/^w\d+$/.test(name)) return `x${name.slice(1)}`;
	if (/^x\d+$/.test(name)) return `w${name.slice(1)}`;
	if (/^s\d+$/.test(name)) return `d${name.slice(1)}`;
	if (/^d\d+$/.test(name)) return `s${name.slice(1)}`;
	return null;
}

function access_key(op: string, reg: string): string {
	const cls = reg_class(reg);
	const width =
		cls === "fpr"
			? reg.startsWith("d")
				? 64
				: 32
			: reg.startsWith("x") || ["sp", "fp", "lr", "xzr"].includes(reg)
				? 64
				: 32;
	return `${cls}${width}`;
}

/** Registers an instruction WRITES. Loads/ALU/cset write their destination;
 *  ldp writes both; stores/compares/branches write nothing; bl/blr/svc/br
 *  are handled by the caller (caller-saved set / opaque). */
function instr_defs(instr: AsmInstruction): string[] {
	switch (instr.op) {
		case "str":
		case "strb":
		case "strh":
		case "stp":
		case "cmp":
		case "tst":
		case "cmn":
		case "b":
		case "ret":
			return [];
		case "bl":
		case "blr":
		case "br":
		case "svc":
			return CALLER_SAVED;
		default:
			break;
	}
	if (instr.op.startsWith("b.")) return [];
	const defs: string[] = [];
	for (const o of instr.operands) {
		if (o.kind === "mem") break; // destinations precede the memory operand
		if (o.kind === "cond") break;
		if (o.kind === "reg") defs.push(o.name);
		else break;
	}
	return defs;
}

export function optimize_frame_slots(code: string): string {
	const lines = code.split("\n");
	const out: string[] = [];

	let slots = new Map<number, SlotState>();
	/** Known zero-extension width (bits) per register (xN-keyed): set by
	 *  ldrb/ldrh/ldr-w (w writes zero the upper half), killed by any
	 *  other definition. Lets a sub-width reload be elided when the
	 *  pending store's source register already holds exactly the
	 *  zero-extended stored value. */
	let zextW = new Map<string, number>();

	const flush_slot = (off: number) => {
		const s = slots.get(off);
		if (s?.pendText !== undefined) out.push(s.pendText);
		slots.delete(off);
	};
	const flush_all = () => {
		for (const off of Array.from(slots.keys()).sort((a, b) => a - b)) flush_slot(off);
	};
	const clear_all = () => {
		slots = new Map();
		zextW = new Map();
	};

	/** A register is REDEFINED: pends sourced from it must reach memory now
	 *  (deferring would store the new value); availability held in it dies.
	 *  Width siblings share fate (w/x and s/d views of one register). */
	const clobber = (reg: string) => {
		if (!reg) return;
		const sib = sibling_reg(reg);
		zextW.delete(reg.startsWith("w") ? `x${reg.slice(1)}` : reg);
		if (sib && sib.startsWith("x")) zextW.delete(sib);
		for (const [off, s] of [...slots.entries()].sort((a, b) => a[0] - b[0])) {
			if (
				s.pendText !== undefined &&
				s.pendReg &&
				(s.pendReg === reg || (sib !== null && s.pendReg === sib))
			) {
				out.push(s.pendText);
				slots.delete(off);
				continue;
			}
			if (s.availReg === reg || (sib !== null && s.availReg === sib)) {
				delete s.availReg;
				delete s.availKey;
			}
		}
	};

	function process_frame_access(instr: AsmInstruction, off: number): void {
		const data_reg = instr.operands[0];
		if (data_reg.kind !== "reg") {
			out.push(instr.text);
			return;
		}
		const is_store = instr.op.startsWith("str");
		const key = access_key(instr.op, data_reg.name);
		const op = instr.op;

		if (!is_store) {
			// Load into the SAME register a same-width pending store came
			// from. Full-width (str xN → ldr xN): the register still
			// holds exactly the stored 8 bytes. Sub-width (strb wN →
			// ldrb wN): the reload is an identity when the register is
			// KNOWN zero-extended to the store's width (the zext fact —
			// without it the reload's zero-extension of the upper bits
			// would be an observable register change; the pick
			// corruption receipt). Checked BEFORE the clobber below,
			// which would materialize the pending store and make this
			// case unreachable.
			const s0 = slots.get(off);
			const reload_width =
				op === "ldrb"
					? 8
					: op === "ldrh"
						? 16
						: op === "ldr" && data_reg.name.startsWith("x")
							? 64
							: 0;
			const known = s0?.pendReg
				? zextW.get(s0.pendReg.startsWith("w") ? `x${s0.pendReg.slice(1)}` : s0.pendReg)
				: undefined;
			if (
				s0?.pendText !== undefined &&
				s0.pendKey === key &&
				s0.pendReg === data_reg.name &&
				(key === "gpr64" || (reload_width > 0 && known !== undefined && known >= reload_width))
			) {
				// Commit the store AT ITS ORIGINAL POSITION (a later flush
				// could land it after epilogue instructions that move
				// x29/sp — the pick-corruption receipt), drop only the
				// redundant load, and record the register as holding the
				// slot's value for future load elision.
				out.push(s0.pendText);
				slots.delete(off);
				const fresh: SlotState = { availReg: data_reg.name, availKey: key };
				slots.set(off, fresh);
				return;
			}
			clobber(data_reg.name);
		}

		// Attach (don't detach!) the slot state so mutations persist.
		let s = slots.get(off);
		if (!s) {
			s = {};
			slots.set(off, s);
		}

		if (is_store) {
			// Same-key pending store overwritten before any read: dropped.
			if (s.pendText !== undefined && s.pendKey !== key) out.push(s.pendText);
			slots.set(off, { pendKey: key, pendText: instr.text, pendReg: data_reg.name });
			return;
		}

		// Load. Forward from a live matching pending store…
		if (s.pendText !== undefined && s.pendKey === key && s.pendReg && s.pendReg !== data_reg.name) {
			const indent = instr.text.match(/^\s*/)?.[0] ?? "";
			const mv = reg_class(data_reg.name) === "fpr" ? "fmov" : "mov";
			out.push(`${indent}${mv} ${data_reg.name}, ${s.pendReg}`);
			s.availReg = data_reg.name;
			s.availKey = key;
			return;
		}
		// …or elide when reloading into the very register the store came from.
		if (s.pendText !== undefined && s.pendKey === key && s.pendReg === data_reg.name) {
			s.availReg = data_reg.name;
			s.availKey = key;
			return;
		}
		// Conflicting or dead-source pending store: materialize first.
		if (s.pendText !== undefined) {
			out.push(s.pendText);
			delete s.pendText;
			delete s.pendKey;
			delete s.pendReg;
		}
		// Redundant-load elimination within matching family/width.
		if (s.availReg && s.availKey === key && s.availReg !== data_reg.name) {
			const indent = instr.text.match(/^\s*/)?.[0] ?? "";
			const mv = reg_class(data_reg.name) === "fpr" ? "fmov" : "mov";
			out.push(`${indent}${mv} ${data_reg.name}, ${s.availReg}`);
			s.availReg = data_reg.name;
			return;
		}
		s.availReg = data_reg.name;
		s.availKey = key;
		if (op === "ldrb" || op === "ldrh") {
			zextW.set(
				data_reg.name.startsWith("w") ? `x${data_reg.name.slice(1)}` : data_reg.name,
				op === "ldrb" ? 8 : 16,
			);
		}
		out.push(instr.text);
	}

	for (let i = 0; i < lines.length; i++) {
		const text = lines[i];
		const trimmed = text.trim();
		if (!trimmed || trimmed.startsWith("//")) {
			out.push(text);
			continue;
		}
		const label_m = /^([A-Za-z_.$][\w.$]*):/.exec(trimmed);
		if (label_m || trimmed.startsWith(".") || /^[\w.$]+\s*=\s*[\w.$]+$/.exec(trimmed)) {
			flush_all();
			out.push(text);
			continue;
		}

		const instr = parse_asm_instruction(text, i + 1);
		if (!instr) {
			// Unparseable line: invisible definitions would corrupt tracking.
			flush_all();
			clear_all();
			out.push(text);
			continue;
		}
		const op = instr.op;

		// Normalize the address idiom `add xK, x29, #M` + `ldr/str XR, [xK]`.
		if (
			op === "add" &&
			instr.operands.length === 3 &&
			instr.operands[0].kind === "reg" &&
			instr.operands[1].kind === "reg" &&
			instr.operands[1].name === "x29" &&
			instr.operands[2].kind === "imm"
		) {
			const scratch = instr.operands[0].name;
			const off = Number(instr.operands[2].value);
			const next = parse_asm_instruction(lines[i + 1] ?? "", i + 2);
			if (
				next &&
				(next.op === "ldr" || next.op === "str") &&
				next.operands.length === 2 &&
				next.operands[1].kind === "mem" &&
				next.operands[1].base === scratch &&
				!next.operands[1].offset &&
				!next.operands[1].scale &&
				!next.operands[1].writeback
			) {
				// The ADD STAYS: the emitter relies on the address remaining
				// live in the scratch register for later instructions (e.g.
				// `ldr x0, [x0, #8]` payload reads after a tag check). The add
				// also REDEFINES the scratch — pending stores sourced from it
				// must materialize first.
				clobber(scratch);
				out.push(text);
				const new_text = next.text.replace(/\[[^\]]*\]/, `[x29, #${off}]`);
				const rewritten: AsmInstruction = {
					...next,
					text: new_text,
					operands: [
						next.operands[0],
						{
							kind: "mem",
							base: "x29",
							offset: { kind: "imm", value: BigInt(off) },
						},
					],
				};
				process_frame_access(rewritten, off);
				i++;
				continue;
			}
			// Any other x29-derived address escapes.
			clobber(scratch);
			flush_all();
			clear_all();
			out.push(text);
			continue;
		}

		const mem = instr.operands.find((o) => o.kind === "mem");

		// Pair accesses touch two offsets: conservative.
		if (
			(op === "ldp" || op === "stp") &&
			mem &&
			mem.kind === "mem" &&
			mem.base === "x29" &&
			mem.offset?.kind === "imm" &&
			!mem.writeback
		) {
			const off0 = Number(mem.offset.value);
			flush_slot(off0);
			flush_slot(off0 + 8);
			slots.delete(off0);
			slots.delete(off0 + 8);
			if (op === "ldp") {
				clobber(instr.operands[0].kind === "reg" ? instr.operands[0].name : "");
				clobber(instr.operands[1].kind === "reg" ? instr.operands[1].name : "");
			}
			out.push(text);
			continue;
		}

		if (
			mem &&
			mem.kind === "mem" &&
			mem.base === "x29" &&
			mem.offset?.kind === "imm" &&
			!mem.writeback
		) {
			process_frame_access(instr, Number(mem.offset.value));
			continue;
		}
		if (
			mem &&
			mem.kind === "mem" &&
			(mem.base === "x29" || mem.base === "fp") &&
			(!mem.offset || mem.offset.kind === "reg" || mem.writeback)
		) {
			// Dynamic or writeback access into the frame — opaque.
			flush_all();
			clear_all();
			out.push(text);
			continue;
		}

		// Calls/opaque transfers define the caller-saved set.
		if (op === "bl" || op === "blr" || op === "br" || op === "svc") {
			for (const r of CALLER_SAVED) clobber(r);
			out.push(text);
			continue;
		}

		// Block-ending branches flush pending stores (joins may read them).
		// Covers b, b.cond, AND the ARM32-style aliases (bne/blt/beq/…)
		// some raw library blocks use; blr/br/svc were handled above.
		if (
			(op.startsWith("b") && op !== "blr" && op !== "br") ||
			op === "cbz" ||
			op === "cbnz" ||
			op === "ret"
		) {
			flush_all();
			out.push(text);
			continue;
		}

		// Everything else: uniform defs handling.
		for (const d of instr_defs(instr)) clobber(d);
		// A zero-extending byte/half load (re)establishes the zext fact
		// for its destination — including NON-frame loads (`ldrb w0,
		// [x0, x1]`), which never reach process_frame_access.
		const load_dst = instr.operands[0];
		if (
			(op === "ldrb" || op === "ldrh" || op === "ldr") &&
			load_dst.kind === "reg" &&
			/^w\d+$/.test(load_dst.name)
		) {
			zextW.set(`x${load_dst.name.slice(1)}`, op === "ldrb" ? 8 : op === "ldrh" ? 16 : 32);
		}
		out.push(text);
	}

	return out.join("\n");
}

let float_forwarding_on = true;

/** Kill-switch for the float-bits forwarding pass (default ON; OFF
 *  restores the untransformed text byte-identically). */
export function float_forwarding_enabled(): boolean {
	return float_forwarding_on;
}

export function set_float_forwarding_enabled(enabled: boolean): void {
	float_forwarding_on = enabled;
}

/**
 * Float-bits forwarding (ASM_PLAN_3 tranche I): the d0 call protocol
 * shuttles float values through integer registers — `fmov x0, d29 …
 * fmov d0, x0` (arg marshalling) and `fmov x0, d0 … fmov d30, x0`
 * (result staging) — two wasted moves per crossing. When `fmov xN, dM`
 * is followed (with xN unredefined in between) by `fmov dK, xN`, the pair
 * collapses to `fmov dK, dM`: 64-bit fmov pairs carry the bits exactly.
 * Records drop at labels (join points may arrive with different
 * provenance) and on any redefinition of xN (calls clobber the
 * caller-saved set, xN included).
 *
 * Deliberately narrow: only the d-form (64-bit) on both ends, only
 * `fmov dK, xN` consumers — `str xN` bit-stores and s/d-width moves keep
 * their explicit form.
 */
export function optimize_float_forwarding(code: string): string {
	if (!float_forwarding_on) return code;
	const lines = code.split("\n");
	const out: string[] = [];
	/** xN → the d-register whose bits xN currently holds. */
	const held = new Map<string, string>();

	/** A register is REDEFINED: records KEYED by it die (the bits are
	 *  gone) and records HOLDING it die (the consumer would read the new
	 *  value, not the copied bits). */
	const drop_reg = (reg: string): void => {
		if (!reg) return;
		const sib = sibling_reg(reg);
		held.delete(reg);
		if (sib) held.delete(sib);
		for (const [k, v] of [...held]) {
			if (v === reg || (sib !== null && v === sib)) held.delete(k);
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const text = lines[i];
		const trimmed = text.trim();
		if (!trimmed || trimmed.startsWith("//")) {
			out.push(text);
			continue;
		}
		const label_m = /^([A-Za-z_.$][\w.$]*):/.exec(trimmed);
		if (label_m || trimmed.startsWith(".") || /^[\w.$]+\s*=\s*[\w.$]+$/.exec(trimmed)) {
			// Label: provenance is path-dependent at join points.
			held.clear();
			out.push(text);
			continue;
		}
		const instr = parse_asm_instruction(text, i + 1);
		if (!instr) {
			held.clear();
			out.push(text);
			continue;
		}
		const op = instr.op;

		// The consumer pattern: `fmov dK, xN` with a live record for xN.
		if (op === "fmov" && instr.operands.length === 2) {
			const dst = instr.operands[0];
			const src = instr.operands[1];
			if (
				dst.kind === "reg" &&
				src.kind === "reg" &&
				dst.name.startsWith("d") &&
				src.name.startsWith("x")
			) {
				const dreg = held.get(src.name);
				if (dreg) {
					if (dst.name === dreg) {
						// Self-move: the rewritten form would be d↔d to itself.
						continue;
					}
					const indent = text.match(/^\s*/)?.[0] ?? "";
					out.push(`${indent}fmov ${dst.name}, ${dreg}`);
					// dK now holds the same bits — and xN's record stays valid
					// (xN was not redefined; it may feed more consumers).
					continue;
				}
			}
		}

		// Producer pattern: `fmov xN, dM` — record it (after invalidating
		// xN's previous record; the fmov defines xN).
		if (op === "fmov" && instr.operands.length === 2) {
			const dst = instr.operands[0];
			const src = instr.operands[1];
			if (
				dst.kind === "reg" &&
				src.kind === "reg" &&
				dst.name.startsWith("x") &&
				src.name.startsWith("d")
			) {
				drop_reg(dst.name);
				held.set(dst.name, src.name);
				out.push(text);
				continue;
			}
		}

		// Everything else: uniform defs handling invalidates records.
		if (op === "bl" || op === "blr" || op === "br" || op === "svc") {
			for (const r of CALLER_SAVED) drop_reg(r);
			out.push(text);
			continue;
		}
		if (
			(op.startsWith("b") && op !== "blr" && op !== "br") ||
			op === "cbz" ||
			op === "cbnz" ||
			op === "ret"
		) {
			// Unconditional control transfer to an out-of-line target: the
			// fall-through provenance no longer applies. (b.cond keeps the
			// record — its fall-through is straight-line, and the taken
			// arm lands on a label that clears.)
			if (op === "b" || op === "br" || op === "ret") held.clear();
			out.push(text);
			continue;
		}
		for (const d of instr_defs(instr)) drop_reg(d);
		out.push(text);
	}

	return out.join("\n");
}

const ALL_TRACKED_REGS: string[] = [];
for (let i = 0; i <= 30; i++) {
	ALL_TRACKED_REGS.push(`x${i}`, `d${i}`);
}
ALL_TRACKED_REGS.push("sp", "xzr");

/**
 * Backward companion to the float forwarding pass: a `fmov xN, dM` whose
 * xN is never read below (before redefinition) is a dead staging move —
 * the d0 protocol's leftover producer after its consumer was rewritten to
 * a direct d↔d move. Pruning is forbidden across labels (the live set
 * resets to the universe there: a jump predecessor may read anything).
 */
function eliminate_dead_float_stage_moves(code: string): string {
	const lines = code.split("\n");
	const out = new Array<string>(lines.length);
	const live = new Set<string>();

	// AArch64 is dest-first: the def is the LEADING register operand
	// (two for ldp). instr_defs deliberately over-approximates (safe for
	// invalidation); pruning needs the exact def or every source operand
	// of a reg-only op would vanish from the live set.
	const defs_of = (instr: AsmInstruction): Set<string> => {
		const defs = new Set<string>();
		switch (instr.op) {
			case "str":
			case "strb":
			case "strh":
			case "stp":
			case "cmp":
			case "tst":
			case "cmn":
			case "ret":
				return defs;
			case "ldp": {
				for (const o of instr.operands) {
					if (o.kind === "reg") {
						defs.add(o.name);
						if (defs.size === 2) break;
					} else break;
				}
				return defs;
			}
			default:
				break;
		}
		if (instr.op.startsWith("b")) return defs;
		for (const o of instr.operands) {
			if (o.kind === "reg") {
				defs.add(o.name);
				break;
			}
			if (o.kind === "mem" || o.kind === "cond") break;
		}
		return defs;
	};
	// Positional reads (see eliminate_dead_copy_moves): skip the leading
	// destination, count the rest — the name-based defs filter cancelled
	// def-and-read registers (`add x0, x0, x1` reported zero reads).
	const reads_of = (instr: AsmInstruction): string[] => {
		const reads: string[] = [];
		let skip: number;
		switch (instr.op) {
			case "str":
			case "strb":
			case "strh":
			case "stp":
			case "cmp":
			case "tst":
			case "cmn":
				skip = 0;
				break;
			case "ldp":
				skip = 2;
				break;
			default:
				skip = READ_ONLY_REG_OPS.has(instr.op) ? 0 : 1;
				break;
		}
		let reg_seen = 0;
		for (const o of instr.operands) {
			if (o.kind === "reg") {
				if (reg_seen++ >= skip) reads.push(o.name);
			} else if (o.kind === "mem") {
				if (o.base) reads.push(o.base);
				if (o.offset?.kind === "reg") reads.push(o.offset.name);
			} else if (o.kind === "cond" || o.kind === "imm") {
				break;
			}
		}
		return reads;
	};

	for (let i = lines.length - 1; i >= 0; i--) {
		const text = lines[i];
		const trimmed = text.trim();
		if (!trimmed || trimmed.startsWith("//")) {
			out[i] = text;
			continue;
		}
		const label_m = /^([A-Za-z_.$][\w.$]*):/.exec(trimmed);
		if (label_m || trimmed.startsWith(".") || /^[\w.$]+\s*=\s*[\w.$]+$/.exec(trimmed)) {
			// Conservative reset: a jump predecessor may read anything.
			live.clear();
			for (const r of ALL_TRACKED_REGS) live.add(r);
			out[i] = text;
			continue;
		}
		const instr = parse_asm_instruction(text, i + 1);
		if (!instr) {
			live.clear();
			for (const r of ALL_TRACKED_REGS) live.add(r);
			out[i] = text;
			continue;
		}
		const op = instr.op;
		// Calls READ their argument registers (and lr) — the lifted text's
		// call operands carry only the target, so the arg set is added
		// explicitly or pre-call argument staging would look dead.
		if (op === "bl") {
			for (let a = 0; a <= 8; a++) live.add(`x${a}`);
			for (let a = 0; a < 8; a++) live.add(`d${a}`);
			live.add("x30");
		} else if (op === "blr") {
			const t = instr.operands.find((o) => o.kind === "reg");
			if (t && t.kind === "reg") live.add(t.name);
			for (let a = 0; a <= 8; a++) live.add(`x${a}`);
			for (let a = 0; a < 8; a++) live.add(`d${a}`);
			live.add("x30");
		} else if (op === "svc") {
			for (let a = 0; a <= 17; a++) live.add(`x${a}`);
		}
		// Prune candidate: a float→int staging fmov whose destination is
		// never read below.
		if (
			op === "fmov" &&
			instr.operands.length === 2 &&
			instr.operands[0].kind === "reg" &&
			instr.operands[1].kind === "reg" &&
			instr.operands[0].name.startsWith("x") &&
			instr.operands[1].name.startsWith("d") &&
			!live.has(instr.operands[0].name)
		) {
			// Drop: dM's read disappears with it (no side effects).
			out[i] = "";
			continue;
		}
		// Backward transfer, defs FIRST: an instruction that reads AND
		// defines the same register keeps the earlier definition's need
		// alive — reads-after-defs would cancel it (the GPR copy pruner's
		// receipt; this pass's fmov pattern just never observed it).
		for (const d of defs_of(instr)) live.delete(d);
		for (const r of reads_of(instr)) live.add(r);
		out[i] = text;
	}

	return out.filter((l) => l !== "").join("\n");
}

/** Full float-forwarding pipeline: consumer rewrite, then dead producer
 *  elimination. */
export function run_float_forwarding(code: string): string {
	if (!float_forwarding_on) return code;
	return eliminate_dead_float_stage_moves(optimize_float_forwarding(code));
}

let dead_moves_on = false;

/** Enable-switch for the dead copy-move elimination (default OFF —
 *  measured −1.3…−1.5% on nbody 5M: the removed `.at()` contract
 *  markers executed in the OoO shadow and their removal perturbs code
 *  layout more than it saves; the same measured-loss convention as the
 *  unroller). Opt-in via `set_dead_move_elimination_enabled`; OFF
 *  restores the untransformed text byte-identically. */
export function dead_move_elimination_enabled(): boolean {
	return dead_moves_on;
}

export function set_dead_move_elimination_enabled(enabled: boolean): void {
	dead_moves_on = enabled;
}

const GPR_PRUNE_SKIP_DESTS = new Set(["sp", "x29", "x30"]);

/**
 * Dead copy-move elimination (ASM_PLAN_4 SLP follow-on): the value
 * protocol parks every result in x0, and several emitters stage
 * addresses through it (`mov x0, xPin` — the fixed-array `.at()`
 * contract marker) only for the consumer to read the pinned register
 * directly. A `mov xD, xS` whose xD is never read below (before
 * redefinition, on every path) is dead.
 *
 * Soundness model — a two-set backward scan:
 * - `live`: registers with an observed read below (defs delete, reads
 *   add, defs BEFORE reads so a def-and-read instruction keeps the
 *   earlier definition's need alive).
 * - `taint`: registers whose liveness is control-flow-unreliable.
 *   Labels, branches and rets taint EVERYTHING (a def on one switch
 *   arm must not kill the join's need for the other arm's definition —
 *   the linear-scan universe reset got this wrong and corrupted
 *   switch-lowering code); defs and reads untaint (a definitive
 *   redefinition, or an observed read, re-establishes exact knowledge);
 *   `bl`/`blr` DEFINitively define the caller-saved set (delete from
 *   both — every path from above crosses the call).
 * A move is pruned only when its destination is in NEITHER set.
 * Frame-pointer, link-register and sp writes are never pruned.
 */
export function eliminate_dead_copy_moves(code: string): string {
	if (!dead_moves_on) return code;
	const lines = code.split("\n");
	const out = new Array<string>(lines.length);
	const live = new Set<string>();
	const tainted = new Set<string>();

	const defs_of = (instr: AsmInstruction): Set<string> => {
		const defs = new Set<string>();
		switch (instr.op) {
			case "str":
			case "strb":
			case "strh":
			case "stp":
			case "cmp":
			case "tst":
			case "cmn":
			case "ret":
				return defs;
			case "ldp": {
				for (const o of instr.operands) {
					if (o.kind === "reg") {
						defs.add(o.name);
						if (defs.size === 2) break;
					} else break;
				}
				return defs;
			}
			default:
				break;
		}
		if (instr.op.startsWith("b")) return defs;
		if (READ_ONLY_REG_OPS.has(instr.op)) return defs;
		for (const o of instr.operands) {
			if (o.kind === "reg") {
				defs.add(o.name);
				break;
			}
			if (o.kind === "mem" || o.kind === "cond") break;
		}
		return defs;
	};
	// Positional reads: skip the LEADING destination register(s), count
	// every other register operand (a dest that is also a source —
	// `add x9, x9, #16` — appears at its source position and IS a read).
	const reads_of = (instr: AsmInstruction): string[] => {
		const reads: string[] = [];
		let skip: number;
		switch (instr.op) {
			case "str":
			case "strb":
			case "strh":
			case "stp":
			case "cmp":
			case "tst":
			case "cmn":
				skip = 0;
				break;
			case "ldp":
				skip = 2;
				break;
			default:
				skip = READ_ONLY_REG_OPS.has(instr.op) ? 0 : 1;
				break;
		}
		let reg_seen = 0;
		for (const o of instr.operands) {
			if (o.kind === "reg") {
				if (reg_seen++ >= skip) reads.push(o.name);
			} else if (o.kind === "mem") {
				if (o.base) reads.push(o.base);
				if (o.offset?.kind === "reg") reads.push(o.offset.name);
			} else if (o.kind === "cond" || o.kind === "imm") {
				break;
			}
		}
		return reads;
	};
	const taint_all = (): void => {
		for (const r of ALL_TRACKED_REGS) tainted.add(r);
	};

	for (let i = lines.length - 1; i >= 0; i--) {
		const text = lines[i];
		const trimmed = text.trim();
		if (!trimmed || trimmed.startsWith("//")) {
			out[i] = text;
			continue;
		}
		const label_m = /^([A-Za-z_.$][\w.$]*):/.exec(trimmed);
		if (label_m || trimmed.startsWith(".") || /^[\w.$]+\s*=\s*[\w.$]+$/.exec(trimmed)) {
			// Join point: liveness is the merge of every predecessor path.
			taint_all();
			out[i] = text;
			continue;
		}
		const instr = parse_asm_instruction(text, i + 1);
		if (!instr) {
			// Unparseable line: invisible definitions would corrupt tracking.
			live.clear();
			taint_all();
			out[i] = text;
			continue;
		}
		const op = instr.op;
		if (op === "ret") {
			// The return value rides x0 (x1 for a fat pair); the ret also
			// ENDS the function — nothing above shares liveness with the
			// text below.
			live.clear();
			live.add("x0");
			live.add("x1");
			live.add("d0");
			live.add("d1");
			taint_all();
			out[i] = text;
			continue;
		}
		if (op === "bl" || op === "blr") {
			// Arguments x0-x8 / d0-d7 are READ (their current values are
			// consumed — a staging move above the call is load-bearing)
			// and their taint resolves; x9-x17 and lr are clobbered
			// (definitive definitions); callee-saved registers are
			// preserved and flow through untouched.
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
			out[i] = text;
			continue;
		}
		if (op === "b" || op.startsWith("b.") || READ_ONLY_REG_OPS.has(op)) {
			// Control flow below the scanned point diverges here.
			taint_all();
			out[i] = text;
			continue;
		}

		// Prune candidate: a register-to-register copy whose destination
		// is neither read below nor control-flow-tainted.
		if (
			op === "mov" &&
			instr.operands.length === 2 &&
			instr.operands[0].kind === "reg" &&
			instr.operands[1].kind === "reg" &&
			/^x\d+$/.test(instr.operands[0].name) &&
			/^x\d+$/.test(instr.operands[1].name) &&
			instr.operands[0].name !== instr.operands[1].name &&
			!GPR_PRUNE_SKIP_DESTS.has(instr.operands[0].name) &&
			!live.has(instr.operands[0].name) &&
			!tainted.has(instr.operands[0].name)
		) {
			// Drop: the copy has no side effects and its source read
			// disappears with it.
			out[i] = "";
			continue;
		}

		// Backward transfer, defs FIRST (a def-and-read instruction keeps
		// the earlier definition's need alive), then reads untaint.
		for (const d of defs_of(instr)) {
			live.delete(d);
			tainted.delete(d);
			const sib = sibling_reg(d);
			if (sib) tainted.delete(sib);
		}
		for (const r of reads_of(instr)) {
			live.add(r);
			const sib = sibling_reg(r);
			if (sib) live.add(sib);
			tainted.delete(r);
			if (sib) tainted.delete(sib);
		}
		out[i] = text;
	}

	return out.filter((l) => l !== "").join("\n");
}

let widen_masks_on = true;

/** Kill-switch for the redundant widen-mask elimination (default ON;
 *  OFF restores the untransformed text byte-identically). */
export function widen_mask_elimination_enabled(): boolean {
	return widen_masks_on;
}

export function set_widen_mask_elimination_enabled(enabled: boolean): void {
	widen_masks_on = enabled;
}

/**
 * Redundant widen-mask elimination (STRING_PLAN tranche 2): a
 * char→int widening cast emits `and xN, xN, #0xFF`, but when the value
 * was produced by an `ldrb wN` the upper bits are ALREADY zero (a w
 * write zeroes bits 63:32, ldrb zero-extends bits 31:8) — the mask is
 * an identity. Track per-register known zero-extension widths through
 * the linear stream (labels/branches/ret and any unparseable line
 * invalidate; bl invalidates caller-saved; defs invalidate; reads
 * preserve) and drop `and xN, xN, #imm` when the known width already
 * covers imm's set bits. Same shape as the float-forwarding held-map.
 */
export function eliminate_redundant_widen_masks(code: string): string {
	if (!widen_masks_on) return code;
	const lines = code.split("\n");
	const out: string[] = [];
	/** reg (xN/wN share the entry, keyed by xN) → known zero-extension
	 *  width in bits (8/16/32). */
	const zext = new Map<string, number>();
	const key = (reg: string): string => (reg.startsWith("w") ? `x${reg.slice(1)}` : reg);

	const kill = (reg: string): void => {
		zext.delete(key(reg));
	};
	const set_zext = (reg: string, width: number): void => {
		zext.set(key(reg), width);
	};

	for (let i = 0; i < lines.length; i++) {
		const text = lines[i];
		const trimmed = text.trim();
		if (!trimmed || trimmed.startsWith("//")) {
			out.push(text);
			continue;
		}
		const label_m = /^([A-Za-z_.$][\w.$]*):/.exec(trimmed);
		if (label_m || trimmed.startsWith(".") || /^[\w.$]+\s*=\s*[\w.$]+$/.exec(trimmed)) {
			zext.clear();
			out.push(text);
			continue;
		}
		const instr = parse_asm_instruction(text, i + 1);
		if (!instr) {
			zext.clear();
			out.push(text);
			continue;
		}
		const op = instr.op;

		// Candidate: `and xN, xN, #imm` whose known zext width covers imm.
		if (
			op === "and" &&
			instr.operands.length === 3 &&
			instr.operands[0].kind === "reg" &&
			instr.operands[1].kind === "reg" &&
			instr.operands[0].name === instr.operands[1].name &&
			instr.operands[0].name.startsWith("x") &&
			instr.operands[2].kind === "imm"
		) {
			const dst = instr.operands[0].name;
			const known = zext.get(dst);
			const imm = instr.operands[2].value;
			if (
				known !== undefined &&
				imm >= 0n &&
				imm < 1n << BigInt(known) && // every set bit is below the known-zero boundary
				(imm & (imm + 1n)) === 0n // low bits all set (a real mask)
			) {
				continue; // identity — drop
			}
		}

		// Fact updates.
		if (op === "bl" || op === "blr" || op === "svc") {
			for (let a = 0; a <= 17; a++) kill(`x${a}`);
			for (let a = 0; a < 8; a++) kill(`d${a}`);
			zext.delete("x30");
			out.push(text);
			continue;
		}
		if (op === "ldrb" || op === "ldrh" || op === "ldr") {
			const dst = instr.operands[0];
			if (dst.kind === "reg" && /^w\d+$/.test(dst.name)) {
				set_zext(dst.name, op === "ldrb" ? 8 : op === "ldrh" ? 16 : 32);
				out.push(text);
				continue;
			}
		}
		// Any other definition of a tracked register kills its fact; pure
		// reads (stores, compares, branches) preserve every fact.
		const is_store_like =
			op === "str" ||
			op === "strb" ||
			op === "strh" ||
			op === "stp" ||
			op === "cmp" ||
			op === "tst" ||
			op === "cmn" ||
			op.startsWith("b.") ||
			op === "b" ||
			op === "cbz" ||
			op === "cbnz" ||
			op === "tbz" ||
			op === "tbnz" ||
			op === "ret";
		if (!is_store_like) {
			for (const o of instr.operands) {
				if (o.kind === "reg") {
					kill(o.name);
					break; // only the leading (destination) register
				}
				if (o.kind === "mem" || o.kind === "cond") break;
			}
		}
		out.push(text);
	}

	return out.join("\n");
}
