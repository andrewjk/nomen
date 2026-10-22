/**
 * Large-frame access shims — rewrite frame accesses whose immediates exceed
 * the AArch64 encoding limits.
 *
 * The emitters address locals as `[x29, #imm]` and take addresses as
 * `add xN, x29, #imm`, both of which are single instructions whose immediate
 * fields top out at 4095 (`add` imm12; scaled load/store tops out higher but
 * is still finite). A local array of >= ~16 KB pushes every later local past
 * those limits, and the assembler rejects the function outright. The same
 * limit bites the frame itself: `sub/add sp, sp, #imm` is an imm12 too, so a
 * large frame fails before any access to it.
 *
 * This pass runs over the final program text (before the optimization
 * pipeline, so no later pass sees an out-of-range form) and rewrites the
 * out-of-range shapes into immediate-free sequences:
 *
 * - `sub/add sp, sp, #big`  → a chain of in-range imm12 adjustments (keeps
 *   the stack-balance dataflow exact — no register form to poison it).
 * - `add xD, x29, #big`     → `mov xD, #big; add xD, x29, xD` (the
 *   destination register stages its own address).
 * - `ldr xD, [x29, #big]`   → `mov xD, #big; ldr xD, [x29, xD]` (same trick;
 *   the load's destination is free to clobber).
 * - every other load/store (stores, sub-word widths, float/vector registers,
 *   ldp/stp pairs) → the x17 scratch: `mov x17, #big` (+ `add x17, x29, x17`
 *   for the pair forms, which have no register-offset encoding).
 *
 * The same limits bite RECEIVER-relative field accesses: `[xN, #big]` where
 * xN holds a struct pointer (x19 in methods), and `add xD, xN, #big` for the
 * address-of form. A struct past ~4-7 KB of fields crosses the encodings the
 * moment any field sits far enough into the body (scaled x-loads reach 32760,
 * but sub-word scaled forms and `add` top out at 4095, ldur/stur at 255, and
 * ldp/stp at 504). These rewrite exactly like the frame forms, except the
 * base register is a live receiver that must survive:
 *
 * - `add xD, xN, #big` with xD != xN → the destination stages its own
 *   address (`mov xD, #big; add xD, xN, xD`); with xD == xN the offset goes
 *   through x17 (staging into the destination would destroy the base).
 * - loads whose destination is an x-register distinct from the base stage
 *   their own address; everything else goes through x17, including pair
 *   forms (`mov x17, #big; add x17, xN, x17; ldp a, b, [x17]`).
 * - Scaled accesses rewrite only past their TRUE encodable range, so in-range
 *   code (e.g. `str x3, [x19, #4104]`) stays single-instruction.
 *
 * x17 is safe as the universal scratch here because this pass runs BEFORE the
 * optimization pipeline: the passes that claim x16/x17 (loop promotion,
 * select registers, pointer walks) validate their claim against the function
 * text and refuse when x17 already appears — losing an optimization on
 * large-frame functions, which is the correct trade. Raw `#arch: aarch64`
 * bodies in the core library never hold a live value in x17 across an
 * out-of-range access (the corpus has none: such accesses did not assemble
 * before this pass existed). x17 is never live across a `bl` by the backend's
 * own convention, and the shims contain no calls. The receiver register is
 * never x17 (emitters keep receivers in x0–x16/x19–x28), so staging into x17
 * cannot clobber the base; a base-x17 line is left untouched rather than
 * mis-staged.
 */

/** First scratch that no emitter or raw body relies on across statements. */
const SCRATCH = "x17";

/** The imm12 ceiling shared by `add imm` and the byte-scaled load/store. */
const IMM12_MAX = 4095;

/** simm9 ceiling (non-negative side) for the unscaled ldur/stur family. */
const SIMM9_MAX = 255;

/** mov (movz/movk expanded) that materializes any non-negative constant. */
function emit_mov_imm(reg: string, imm: number): string[] {
	if (imm <= 65535) return [`mov ${reg}, #${imm}`];
	const chunks: number[] = [];
	let rest = imm;
	while (rest > 0) {
		chunks.push(rest % 65536);
		rest = Math.floor(rest / 65536);
	}
	const out = [`movz ${reg}, #${chunks[0]}`];
	for (let i = 1; i < chunks.length; i++) {
		if (chunks[i] === 0) continue;
		out.push(`movk ${reg}, #${chunks[i]}, lsl #${i * 16}`);
	}
	return out;
}

/** `sub/add sp, sp, #imm` with imm > 4095 → a chain of imm12-sized steps. */
function rewrite_sp_adjust(op: string, imm: number): string[] {
	const out: string[] = [];
	let rest = imm;
	while (rest > IMM12_MAX) {
		out.push(`${op} sp, sp, #${IMM12_MAX}`);
		rest -= IMM12_MAX;
	}
	if (rest > 0) out.push(`${op} sp, sp, #${rest}`);
	return out;
}

// `ldr/str` with the optional width suffix; the register token covers x/w/d/s
// (and xzr). The trailing comment, when present, is preserved on the shim.
const MEM_RE = /^(ldr|str)([bhw]?) ([a-z][a-z0-9]*), \[x29, #(\d+)\](\s*\/\/.*)?$/;
const PAIR_RE = /^(ldp|stp) ([^,]+), ([^,]+), \[x29, #(\d+)\](\s*\/\/.*)?$/;
const ADD_X29_RE = /^add (x[0-9]+), x29, #(\d+)(\s*\/\/.*)?$/;
const SP_ADJ_RE = /^(sub|add) sp, sp, #(\d+)$/;
/** True for full 64-bit integer registers usable as their own address scratch
 *  (xzr excluded: `ldr xzr` still performs the load, and xzr can't stage). */
const IS_X_REG = /^x([0-9]|[12][0-9]|3[01])$/;

// Receiver-relative field accesses — any x-register base except x29 (the
// frame branches above claim those first). The full load/store mnemonic
// family: scaled ldr/str + width suffixes + sign-extending loads, and the
// unscaled ldur/stur pairs the field-pair emitters fall back to.
const X_BASE = "(x(?:[0-9]|[12][0-9]|3[01]))";
const MEM_RECV_RE = new RegExp(
	`^(ldr|ldrb|ldrh|ldrsb|ldrsh|ldrsw|ldur|ldurb|ldurh|ldursb|ldursh|ldursw|str|strb|strh|stur|sturb|sturh) ([a-z][a-z0-9]*), \\[${X_BASE}, #(\\d+)\\](\\s*\\/\\/.*)?$`,
);
const PAIR_RECV_RE = new RegExp(
	`^(ldp|stp) ([^,]+), ([^,]+), \\[${X_BASE}, #(\\d+)\\](\\s*\\/\\/.*)?$`,
);
const ADD_RECV_RE = new RegExp(`^add ${X_BASE}, ${X_BASE}, #(\\d+)(\\s*\\/\\/.*)?$`);

/** Register-offset spelling of the unscaled ldur/stur family: the unscaled
 *  encodings have no register-offset form, so an out-of-range unscaled access
 *  rewrites to its scaled mnemonic (identical semantics — the immediate is
 *  non-negative, so the missing sign-extension reach is unused). */
const SCALED_OF: Record<string, string> = {
	ldur: "ldr",
	stur: "str",
	ldurb: "ldrb",
	sturb: "strb",
	ldurh: "ldrh",
	sturh: "strh",
	ldursb: "ldrsb",
	ldursh: "ldrsh",
	ldursw: "ldrsw",
};

/** Largest non-negative immediate a SCALED load/store encodes: imm12 scaled
 *  by the access width (byte 4095 … quad 65520). The width comes from the
 *  mnemonic's suffix where present, else the destination register's class.
 */
function scaled_imm_max(op: string, reg: string): number {
	if (op.endsWith("b")) return IMM12_MAX;
	if (op.endsWith("h")) return IMM12_MAX * 2;
	if (op === "ldrsw") return IMM12_MAX * 4;
	if (reg.startsWith("q")) return IMM12_MAX * 16;
	if (reg.startsWith("x") || reg.startsWith("d")) return IMM12_MAX * 8;
	if (reg.startsWith("w") || reg.startsWith("s")) return IMM12_MAX * 4;
	if (reg.startsWith("h")) return IMM12_MAX * 2;
	return IMM12_MAX;
}

/** Largest non-negative immediate a pair form encodes: simm7 scaled by the
 *  element size (8-byte pairs 504, 16-byte pairs 1008). */
function pair_imm_max(reg: string): number {
	const scale = reg.startsWith("q") ? 16 : reg.startsWith("w") || reg.startsWith("s") ? 4 : 8;
	return 63 * scale;
}

export function rewrite_large_frame_offsets(asm: string): string {
	const lines = asm.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const sp = SP_ADJ_RE.exec(line.trim());
		if (sp && Number(sp[2]) > IMM12_MAX) {
			out.push(...rewrite_sp_adjust(sp[1], Number(sp[2])));
			continue;
		}

		const add = ADD_X29_RE.exec(line.trim());
		if (add && Number(add[2]) > IMM12_MAX) {
			const reg = add[1];
			for (const l of emit_mov_imm(reg, Number(add[2]))) out.push(l);
			out.push(`add ${reg}, x29, ${reg}${add[3] ?? ""}`);
			continue;
		}

		const mem = MEM_RE.exec(line.trim());
		if (mem && Number(mem[4]) > IMM12_MAX) {
			const [, op, width, reg, imm_s, comment] = mem;
			const imm = Number(imm_s);
			if (op === "ldr" && IS_X_REG.test(reg)) {
				// The load's destination stages its own address.
				for (const l of emit_mov_imm(reg, imm)) out.push(l);
				out.push(`ldr ${reg}, [x29, ${reg}]${comment ?? ""}`);
			} else {
				for (const l of emit_mov_imm(SCRATCH, imm)) out.push(l);
				out.push(`${op}${width} ${reg}, [x29, ${SCRATCH}]${comment ?? ""}`);
			}
			continue;
		}

		const pair = PAIR_RE.exec(line.trim());
		if (pair && Number(pair[4]) > IMM12_MAX) {
			const [, op, a, b, imm_s, comment] = pair;
			for (const l of emit_mov_imm(SCRATCH, Number(imm_s))) out.push(l);
			out.push(`add ${SCRATCH}, x29, ${SCRATCH}`);
			out.push(`${op} ${a}, ${b}, [${SCRATCH}]${comment ?? ""}`);
			continue;
		}

		// Receiver-relative address-of: `add xD, xN, #big`. The destination
		// stages its own address when distinct from the base; when the base
		// IS the destination (access_staging folds `d += leaf` forms), the
		// offset goes through x17 — staging into the destination would
		// destroy the base before the add reads it.
		const add_recv = ADD_RECV_RE.exec(line.trim());
		if (add_recv && Number(add_recv[3]) > IMM12_MAX) {
			const [, dest, base, imm_s, comment] = add_recv;
			const imm = Number(imm_s);
			if (base !== SCRATCH) {
				const stage = dest !== base ? dest : SCRATCH;
				for (const l of emit_mov_imm(stage, imm)) out.push(l);
				out.push(`add ${dest}, ${base}, ${stage}${comment ?? ""}`);
				continue;
			}
		}

		// Receiver-relative load/store: `op reg, [xN, #big]`. Unscaled
		// ldur/stur forms top out at simm9; scaled forms at their width's
		// imm12 reach. A load whose x-register destination is distinct from
		// the base stages its own address (the base survives the clobber);
		// everything else — stores, sub-word widths, float/vector registers,
		// destination==base — goes through the x17 scratch. The unscaled
		// encodings have no register-offset form, so their shims emit the
		// scaled mnemonic (identical semantics for a non-negative offset).
		const mem_recv = MEM_RECV_RE.exec(line.trim());
		if (mem_recv) {
			const [, op, reg, base, imm_s, comment] = mem_recv;
			const imm = Number(imm_s);
			const limit =
				op.startsWith("ldur") || op.startsWith("stur") ? SIMM9_MAX : scaled_imm_max(op, reg);
			if (imm > limit && base !== SCRATCH) {
				const is_load = op.startsWith("ldr");
				const emit_op = SCALED_OF[op] ?? op;
				if (is_load && IS_X_REG.test(reg) && reg !== base) {
					for (const l of emit_mov_imm(reg, imm)) out.push(l);
					out.push(`${emit_op} ${reg}, [${base}, ${reg}]${comment ?? ""}`);
				} else {
					for (const l of emit_mov_imm(SCRATCH, imm)) out.push(l);
					out.push(`${emit_op} ${reg}, [${base}, ${SCRATCH}]${comment ?? ""}`);
				}
				continue;
			}
		}

		// Receiver-relative pairs: `ldp/stp a, b, [xN, #big]`. Pairs have no
		// register-offset encoding, so the staged address materializes into
		// x17 (`add x17, xN, x17`).
		const pair_recv = PAIR_RECV_RE.exec(line.trim());
		if (
			pair_recv &&
			Number(pair_recv[5]) > pair_imm_max(pair_recv[2]) &&
			pair_recv[4] !== SCRATCH
		) {
			const [, op, a, b, base, imm_s, comment] = pair_recv;
			for (const l of emit_mov_imm(SCRATCH, Number(imm_s))) out.push(l);
			out.push(`add ${SCRATCH}, ${base}, ${SCRATCH}`);
			out.push(`${op} ${a}, ${b}, [${SCRATCH}]${comment ?? ""}`);
			continue;
		}

		out.push(line);
	}
	return out.join("\n");
}
