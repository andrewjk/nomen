/**
 * Release-mode optimization pipeline over generated AArch64 assembly.
 *
 * The C backend gets clang `-O2` for free, but the aarch64 backend emits
 * assembly that clang only assembles — the optimizer never sees it. This
 * pipeline applies the text-level equivalents of the biggest `-O2` wins to
 * the whole-program assembly, gated behind `--release`:
 *
 *   1. Constant propagation + dead-branch folding + mul→lsl strength
 *      reduction (`fold_asm_constants` — the same pass the checker uses to
 *      evaluate monomorphized raw asm, here run over the entire program).
 *   2. Unreachable-code elimination: instructions after an unconditional
 *      `b`/`ret` (until the next label or directive) can never execute.
 *   3. Branch-to-next elimination: `b .Lx` immediately before `.Lx:` falls
 *      through anyway — the branch is a no-op and is dropped.
 *   4. Identity-move elimination: `mov xN, xN` / `fmov dN, dN` write a
 *      register to itself — dropped.
 *
 * Every rule is deliberately conservative (exact-adjacency for rewrites,
 * labels/directives always terminate scans) so it can run over the final
 * text with no CFG. The passes are iterated to a fixpoint because each
 * creates opportunities for the next (a folded constant branch leaves dead
 * code; removing dead code exposes a branch-to-next; …).
 */

import { fold_asm_constants } from "./fold_asm_constants.ts";

// A line that *starts* with a label — including label+data forms the
// emitters produce (`_str_1: .asciz "..."`, `VT_Trait: .quad fn`) and the
// numeric local labels raw `#arch: aarch64` blocks use (`1:`). These are
// join points and data, never instructions, so dead-code scans must stop
// at them.
const LABEL_PREFIX_RE = /^(?:[A-Za-z_.$][\w.$]*|\d+):/;
// Unconditional control transfers only: `b label`, `br reg`, `ret`. A `.`
// boundary is NOT enough — it would also match conditional `b.eq`/`b.gt`,
// which fall through and must not start a dead region.
const TERM_RE = /^(?:b|br|ret)(?:\s|$)/;
const B_RE = /^b\s+(\S+)$/;
const BLANK_OR_COMMENT = (line: string): boolean =>
	line.trim() === "" || line.trim().startsWith("//");

/** Resolve a branch operand to the label line it names, if it is a plain
 *  (or forward numeric `2f`) label reference. Returns the label text as it
 *  would appear at the start of its definition line. */
function branch_target_label(target: string): string | undefined {
	const dir = /^(\d+)[fb]$/.exec(target);
	if (dir) return `${dir[1]}:`; // forward numeric reference (`2f`)
	if (/^[A-Za-z_.$][\w.$]*$/.test(target)) return `${target}:`;
	return undefined;
}

/** Is this an instruction line (not blank, comment, directive, or label)? */
function is_instruction(line: string): boolean {
	const t = line.trim();
	if (!t || t.startsWith("//") || t.startsWith(".")) return false;
	if (LABEL_PREFIX_RE.test(t)) return false;
	return true;
}

/**
 * Drop instructions that follow an unconditional control transfer (`b`,
 * `br`, `ret`) until the next label or assembler directive. Labels stop the
 * scan (they may be branch targets from elsewhere); directives stop it (they
 * may emit data or affect alignment of what follows). Blank lines and
 * comments are skipped and removed along with the dead instructions.
 */
export function remove_unreachable_code(asm: string): string {
	const lines = asm.split("\n");
	const out: string[] = [];
	let dead = false;
	for (const line of lines) {
		const t = line.trim();
		if (LABEL_PREFIX_RE.test(t) || t.startsWith(".")) {
			dead = false;
			out.push(line);
			continue;
		}
		if (dead) {
			// Remove the dead instruction/comment; keep blank-line structure
			// simple by dropping the line entirely.
			continue;
		}
		out.push(line);
		if (is_instruction(line) && TERM_RE.test(t)) dead = true;
	}
	return out.join("\n");
}

/**
 * Remove `b .Lx` when `.Lx:` is the next label reached by falling through
 * (only blank lines, comments, and directives may sit between). Executing
 * the branch and falling through end at the same place, so the branch is a
 * no-op.
 */
export function remove_branch_to_next(asm: string): string {
	const lines = asm.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i].trim();
		const m = B_RE.exec(t);
		if (m) {
			// Only forward references (plain labels, `Nf`) can be branch-to-next;
			// a backward `Nb` target by definition precedes this branch.
			const label = branch_target_label(m[1]);
			if (label && !/\d+b$/.test(m[1])) {
				let j = i + 1;
				while (j < lines.length && BLANK_OR_COMMENT(lines[j])) j++;
				if (j < lines.length && lines[j].trim().startsWith(label)) {
					// Branch jumps exactly where fall-through lands — drop it.
					continue;
				}
			}
		}
		out.push(lines[i]);
	}
	return out.join("\n");
}

const REG_RE = /^[wxsdhbqv][0-9]{1,2}$/;

/**
 * Drop `mov xN, xN` / `fmov dN, dN`. Writing a register to itself has no
 * architectural effect (no flags are set by mov/fmov).
 */
export function remove_identity_moves(asm: string): string {
	const lines = asm.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const m = /^(mov|fmov)\s+(\S+), (\S+)$/.exec(line.trim());
		if (m && REG_RE.test(m[2]) && m[2] === m[3]) continue;
		out.push(line);
	}
	return out.join("\n");
}

/**
 * Run the release pipeline over whole-program aarch64 assembly. Iterates to
 * a fixpoint (bounded — each pass strictly shrinks or preserves the text, so
 * it converges quickly; the cap is a safety net).
 *
 * Deliberately NOT included: dropping an adjacent `str xN, [addr]` /
 * `ldr xN, [addr]` pair. It preserves register state but deletes the only
 * write to the slot — a later non-adjacent `ldr` of the same address (the
 * spill/reload idiom in raw library asm, e.g. int_to_string's
 * `str x0, [sp, #72]` … final `ldr x0, [sp, #72]`) then reads garbage.
 * Soundness needs stack-slot liveness, which a text pass can't do.
 */
export function optimize_asm(asm: string): string {
	let current = asm;
	for (let round = 0; round < 8; round++) {
		const next = remove_identity_moves(
			remove_branch_to_next(remove_unreachable_code(fold_asm_constants(current))),
		);
		if (next === current) break;
		current = next;
	}
	return current;
}
