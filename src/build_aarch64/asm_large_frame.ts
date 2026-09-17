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
 * x17 is safe as the universal scratch here because this pass runs BEFORE the
 * optimization pipeline: the passes that claim x16/x17 (loop promotion,
 * select registers, pointer walks) validate their claim against the function
 * text and refuse when x17 already appears — losing an optimization on
 * large-frame functions, which is the correct trade. Raw `#arch: aarch64`
 * bodies in the core library never hold a live value in x17 across an
 * out-of-range `[x29, #imm]` access (the corpus has none: such accesses did
 * not assemble before this pass existed). x17 is never live across a `bl`
 * by the backend's own convention, and the shims contain no calls.
 */

/** First scratch that no emitter or raw body relies on across statements. */
const SCRATCH = "x17";

/** The imm12 ceiling shared by `add imm` and the scaled load/store forms. */
const IMM12_MAX = 4095;

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

		out.push(line);
	}
	return out.join("\n");
}
