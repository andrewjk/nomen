/**
 * Final-address expansion (runs last, after every optimizer that
 * pattern-matches the `adr` form). `adr` is PC-relative with a ±1 MB reach;
 * in a large program (allmark's generated spec tests assemble to 1.5-3 MB of
 * asm) the string and constant labels in `.data` sit more than 1 MB from the
 * code that uses them, and the assembler rejects every `adr xN, _str_KNN`
 * with "fixup value out of range".
 *
 * Rewrite `adr xN, SYM` into the page-relative pair the vtable install already
 * uses — `adrp xN, SYM@PAGE` + `add xN, xN, SYM@PAGEOFF` (adrp reaches ±4 GB).
 *
 * Only NON-LOCAL symbols are rewritten: a label beginning with `.` (or a
 * numeric `Nf`/`Nb` local) is intra-function and within reach, so it stays an
 * `adr` — keeping the emitted text of small programs unchanged.
 */
const ADR_RE = /^(\s*)adr (x[0-9]+), ([A-Za-z_][A-Za-z0-9_]*)\s*$/;

export function expand_far_adr_addresses(code: string): string {
	const lines = code.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = ADR_RE.exec(lines[i]);
		if (!m) continue;
		const [, indent, reg, sym] = m;
		lines[i] = `${indent}adrp ${reg}, ${sym}@PAGE\n${indent}add ${reg}, ${reg}, ${sym}@PAGEOFF`;
	}
	return lines.join("\n");
}
