/**
 * Large-immediate expansion (final pass, runs after every optimizer so the
 * passes see the canonical `mov xN, #imm` form). The AArch64 `mov` alias
 * only encodes a 16-bit immediate (movz; movn for the small negatives the
 * emitters use). An emitter site that hands a bigger constant to the plain
 * `mov` form — a long string literal's byte length, a big array count, a
 * large struct size — produces a line the assembler rejects outright. This
 * pass rewrites those lines in place into a movz/movk chunk chain (positive)
 * or the movn + movk form (negative), the same shapes
 * asm_large_frame's frame-offset rewriter emits.
 */

/** movz/movk expansion of a non-negative constant (shared shape with
 *  asm_large_frame's emit_mov_imm). */
function expand_positive(reg: string, k: number): string[] {
	const out = [`movz ${reg}, #${k % 65536}`];
	let rest = Math.floor(k / 65536);
	let shift = 16;
	while (rest > 0) {
		const chunk = rest % 65536;
		if (chunk !== 0) out.push(`movk ${reg}, #${chunk}, lsl #${shift}`);
		rest = Math.floor(rest / 65536);
		shift += 16;
	}
	return out;
}

/** movn + movk expansion of a negative constant: materialize the two's
 *  complement bit pattern (movn inverts chunk 0 and sets every higher bit;
 *  each movk then overwrites its chunk verbatim — so EVERY higher chunk is
 *  emitted, including zeros). */
function expand_negative(reg: string, k: number): string[] {
	const pattern = (1n << 64n) + BigInt(k); // two's complement, 64-bit
	const mask = 0xffffn;
	const out = [`movn ${reg}, #${(~pattern & mask).toString()}`];
	for (let i = 1; i < 4; i++) {
		const chunk = (pattern >> BigInt(16 * i)) & mask;
		out.push(`movk ${reg}, #${chunk}, lsl #${16 * i}`);
	}
	return out;
}

const MOV_IMM_RE = /^(\s*)mov (x|w)([0-9]+), #(-?\d+)$/;

export function expand_large_mov_immediates(code: string): string {
	const lines = code.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = MOV_IMM_RE.exec(lines[i]);
		if (!m) continue;
		const [, indent, cls, num, imm_text] = m;
		const k = Number(imm_text);
		if (!Number.isFinite(k) || !Number.isInteger(k)) continue;
		// Within the `mov` alias's encoding range: movz covers 0..65535,
		// movn covers -1..-65536. Leave those (and anything too wide for a
		// 32-bit w register, which is the emitter's bug to surface).
		if (k >= -65536 && k <= 65535) continue;
		const reg = `${cls}${num}`;
		const replacement = k > 0 ? expand_positive(reg, k) : expand_negative(reg, k);
		lines[i] = replacement.map((line) => `${indent}${line}`).join("\n");
	}
	return lines.join("\n");
}
