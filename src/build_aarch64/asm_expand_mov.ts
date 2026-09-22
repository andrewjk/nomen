/**
 * Large-immediate expansion (final pass, runs after every optimizer so the
 * passes see the canonical `mov xN, #imm` / `ldr xN, =K` forms).
 *
 * Two AArch64 hazards this pass removes:
 *  - The `mov` alias only encodes a 16-bit immediate (movz; movn for small
 *    negatives). An emitter site that hands a bigger constant to the plain
 *    `mov` form — a long string literal's byte length, a big array count, a
 *    large struct size — produces a line the assembler rejects outright.
 *  - `ldr xN, =K` needs a literal pool the assembler must site within ±1 MB
 *    of the load. In a multi-MB program (allmark's generated spec tests) the
 *    pool falls out of range and the assembler reports "fixup value out of
 *    range".
 *
 * Both are rewritten to a movz/movk chunk chain (positive) or the
 * movn + movk form (negative), exactly materializing the 64-bit constant. The
 * chunks are computed on BigInt so a full-width `uint64` (or a value written
 * as a hex literal) is preserved — a JS `number` rounds and can spill into a
 * fifth chunk (`movk …, lsl #64`, which the assembler rejects).
 */

const MASK64 = (1n << 64n) - 1n;
const MASK16 = 0xffffn;

/** Materialize any 64-bit integer constant in `reg`, without a literal pool. */
function materialize_immediate(reg: string, k: bigint): string[] {
	// `mov` (movz) covers 0..65535; `movn` covers -1..-65536.
	if (k >= 0n && k <= 65535n) return [`mov ${reg}, #${k}`];
	if (k < 0n && k >= -65536n) return [`movn ${reg}, #${-k - 1n}`];
	const v = k & MASK64; // two's complement bit pattern for negatives
	const chunk = (i: number) => (v >> BigInt(16 * i)) & MASK16;
	if (k >= 0n) {
		const out = [`movz ${reg}, #${chunk(0)}`];
		for (let i = 1; i < 4; i++) {
			const c = chunk(i);
			if (c !== 0n) out.push(`movk ${reg}, #${c}, lsl #${i * 16}`);
		}
		return out;
	}
	// Negative: movn inverts chunk 0 and sets every higher bit, so every
	// higher chunk is overwritten explicitly (including zeros).
	return [
		`movn ${reg}, #${~chunk(0) & MASK16}`,
		`movk ${reg}, #${chunk(1)}, lsl #16`,
		`movk ${reg}, #${chunk(2)}, lsl #32`,
		`movk ${reg}, #${chunk(3)}, lsl #48`,
	];
}

function parse_imm(text: string): bigint | null {
	try {
		return BigInt(text);
	} catch {
		return null;
	}
}

const MOV_IMM_RE = /^(\s*)mov (x|w)([0-9]+), #(-?\d+)$/;
// `ldr xN, =K` — the emitter's literal-pool constant load.
const LDR_POOL_RE = /^(\s*)ldr (x[0-9]+), =(-?\d+)$/;

export function expand_large_mov_immediates(code: string): string {
	const lines = code.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = MOV_IMM_RE.exec(lines[i]);
		if (m) {
			const [, indent, cls, num, imm_text] = m;
			const k = parse_imm(imm_text);
			if (k === null) continue;
			// Within the `mov` alias's encoding range: movz covers 0..65535,
			// movn covers -1..-65536. Leave those (and anything too wide for a
			// 32-bit w register, which is the emitter's bug to surface).
			if (k >= -65536n && k <= 65535n) continue;
			const reg = `${cls}${num}`;
			lines[i] = materialize_immediate(reg, k)
				.map((line) => `${indent}${line}`)
				.join("\n");
			continue;
		}
		const p = LDR_POOL_RE.exec(lines[i]);
		if (!p) continue;
		const [, indent, reg, imm_text] = p;
		const k = parse_imm(imm_text);
		if (k === null) continue;
		lines[i] = materialize_immediate(reg, k)
			.map((line) => `${indent}${line}`)
			.join("\n");
	}
	return lines.join("\n");
}
