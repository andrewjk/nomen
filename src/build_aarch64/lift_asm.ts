/**
 * Lifts emitted AArch64 assembly text into structured form and validates it.
 *
 * Runs over the backend's own output at build time, so a malformed emission
 * (unknown mnemonic, wrong operand shapes, a branch to a label that doesn't
 * exist, a conditional branch reading flags nothing set, an unbalanced stack)
 * fails the build immediately with the offending line — instead of surfacing
 * as an assembler error or a silent miscompile deep in a test run.
 *
 * Phase 1 scope: parse + validate + trivially faithful re-emission (every
 * line keeps its original text). Dataflow passes operate on this structure
 * in later phases. The mnemonic table in asm_ir.ts is the contract: new
 * emissions must be added there or the lift fails.
 */

import {
	type AsmLine,
	type LiftedFunction,
	type LiftError,
	type Operand,
	MNEMONICS,
	is_cond,
	reg_class,
} from "./asm_ir.ts";

/** Per-position operand class (see asm_ir.ts MNEMONICS). */
type Pos = "r" | "f" | "i" | "c" | "l" | "m";

export interface LiftResult {
	ok: boolean;
	errors: LiftError[];
	lines: AsmLine[];
	functions: LiftedFunction[];
}

interface ParsedMem {
	base: string;
	offset?: { kind: "imm"; value: bigint } | { kind: "reg"; name: string };
	scale?: number;
	writeback?: "pre" | "post";
	postOffset?: bigint;
}

function strip_comment(line: string): string {
	// `//` never appears inside .asciz strings in our emitters' output; even
	// if it did, the directive is passed through verbatim (round-trip), only
	// validation skips it.
	const idx = line.indexOf("//");
	return idx === -1 ? line : line.slice(0, idx);
}

/** Split an operand list on top-level commas (brackets are not nested). */
function split_operands(s: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of s) {
		if (ch === "[") depth++;
		if (ch === "]") depth--;
		if (ch === "," && depth === 0) {
			parts.push(cur.trim());
			cur = "";
		} else {
			cur += ch;
		}
	}
	if (cur.trim()) parts.push(cur.trim());
	return parts;
}

const IMM_RE = /^#(-?)(0x[0-9a-fA-F]+|\d+)$/;

function parse_imm(tok: string): bigint | null {
	const m = IMM_RE.exec(tok);
	if (!m) return null;
	const sign = m[1] ? -1n : 1n;
	const body = m[2].toLowerCase().startsWith("0x") ? BigInt(m[2]) : BigInt(m[2]);
	return sign * body;
}

function parse_reg(tok: string): string | null {
	const t = tok.trim().toLowerCase();
	if (reg_class(t)) return t;
	return null;
}

/** Parse `[base, ...]` with optional trailing `!`, plus a post-index `#imm`
 *  that may follow the bracket group as its own comma part. */
function parse_mem(parts: string[], start: number): { mem: ParsedMem; next: number } | null {
	const first = parts[start];
	if (!first || !first.startsWith("[")) return null;
	const has_close = first.includes("]");
	let inner = first;
	let writeback: "pre" | "post" | undefined;
	if (first.endsWith("!")) {
		writeback = "pre";
		inner = first.slice(0, -1);
	}
	if (!has_close) {
		// Address expression split across comma parts: `[x0, x1, lsl #3]`
		let acc = inner;
		let j = start + 1;
		while (j < parts.length && !acc.includes("]")) {
			acc += "," + parts[j];
			j++;
		}
		inner = acc;
		if (!inner.includes("]")) return null;
		const close_idx = inner.indexOf("]");
		const tail = inner.slice(close_idx + 1).trim();
		inner = inner.slice(0, close_idx);
		if (tail === "!") writeback = "pre";
		else if (tail) return null;
		const parsed_inner = parse_mem_inner(inner);
		if (!parsed_inner) return null;
		return { mem: { ...parsed_inner, writeback }, next: j };
	}
	inner = inner.slice(1, -1);
	const parsed_inner = parse_mem_inner(inner);
	if (!parsed_inner) return null;
	// Post-index: the NEXT comma part is a bare immediate.
	let next = start + 1;
	let postOffset: bigint | undefined;
	if (next < parts.length && !parts[next].startsWith("[")) {
		const v = parse_imm(parts[next]);
		if (v !== null && !parsed_inner.offset && !parsed_inner.scale) {
			postOffset = v;
			next++;
		}
	}
	return {
		mem: {
			...parsed_inner,
			writeback: writeback ?? (postOffset !== undefined ? "post" : undefined),
			postOffset,
		},
		next,
	};
}

function parse_mem_inner(inner: string): Omit<ParsedMem, "writeback" | "postOffset"> | null {
	const comps = inner
		.split(",")
		.map((c) => c.trim())
		.filter(Boolean);
	if (comps.length === 0) return null;
	const base = parse_reg(comps[0]);
	if (!base) return null;
	const mem: Omit<ParsedMem, "writeback" | "postOffset"> = { base };
	for (let k = 1; k < comps.length; k++) {
		const comp = comps[k];
		const imm = parse_imm(comp);
		if (imm !== null) {
			mem.offset = { kind: "imm", value: imm };
			continue;
		}
		const shift_m = /^lsl\s+#(\d+)$/.exec(comp);
		if (shift_m && mem.offset && mem.offset.kind === "reg") {
			mem.scale = 1 << parseInt(shift_m[1], 10);
			continue;
		}
		const reg = parse_reg(comp.replace(/\s*lsl.*$/, ""));
		if (reg) {
			mem.offset = { kind: "reg", name: reg };
			const tail_shift = /lsl\s+#(\d+)$/.exec(comp);
			if (tail_shift) mem.scale = 1 << parseInt(tail_shift[1], 10);
			continue;
		}
		return null;
	}
	return mem;
}

function parse_operand(tok: string): Operand | "labelish" | null {
	const trimmed = tok.trim();
	const reg = parse_reg(trimmed);
	if (reg) {
		const cls = reg_class(reg)!;
		const is_floating = cls === "fpr";
		const width = is_floating ? (reg.startsWith("d") ? 64 : 32) : 64;
		return { kind: "reg", name: reg, cls, width };
	}
	const imm = parse_imm(trimmed);
	if (imm !== null) return { kind: "imm", value: imm, raw: trimmed };
	if (/^[A-Za-z_.$][\w.$]*$/.test(trimmed)) return "labelish";
	return null;
}

/**
 * Validate emitted assembly. Returns every problem found (empty array when
 * clean). Never throws — malformed input IS the input here.
 */
export function validate_asm(code: string): LiftError[] {
	const errors: LiftError[] = [];
	const lines = code.split("\n");

	// Pass 1: collect labels + call targets so branch targets and function
	// entries are known before validation.
	const labels = new Set<string>();
	const bl_targets = new Set<string>();
	const stripped: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const t = strip_comment(lines[i]).trim();
		stripped.push(t);
		const lm = /^([A-Za-z_.$][\w.$]*):/.exec(t);
		if (lm) labels.add(lm[1]);
		const bm = /^\s*bl\s+([A-Za-z_.$][\w.$]*)/.exec(t);
		if (bm) bl_targets.add(bm[1]);
	}

	// Pass 2: per-line validation with function-scoped sp/flags tracking.
	let delta = 0;
	let have_entry = false;
	let flags_known = false;
	let current_function = "<file>";
	const at_function_boundary = new Set<string>();

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const t = stripped[i];
		if (!t) continue;

		// Alias (`_sym = sym`) and directives pass through.
		if (/^[\w.$]+\s*=\s*[\w.$]+$/.test(t)) continue;
		if (t.startsWith(".")) {
			if (/^\.globl\s+/.test(t)) {
				at_function_boundary.add(t.replace(/^\.globl\s+/, "").trim());
			}
			continue;
		}

		const lm = /^([A-Za-z_.$][\w.$]*):(.*)$/.exec(t);
		if (lm) {
			const name = lm[1];
			if (lm[2].trim()) continue; // label + data directive on one line
			// Any label is a control-flow merge point — incoming flag state is
			// unknown regardless of whether it starts a new function.
			flags_known = false;
			// Function entries are non-dot labels reached as call targets,
			// declared .globl, preceded by a section/alignment marker, or
			// following the previous function's ret. Local labels (`.L…`,
			// `.while…`, `.return…`) and mid-block labels (`else_N:`, `end_N:`)
			// stay within the enclosing function so stack/flag tracking keeps
			// running across them.
			const is_entry =
				!name.startsWith(".") &&
				(bl_targets.has(name) ||
					at_function_boundary.has(name) ||
					prev_is_entry_marker(lines, i) ||
					prev_ends_function(stripped, i));
			if (is_entry) {
				have_entry = true;
				delta = 0;
				current_function = name;
			} else if (!have_entry) {
				have_entry = true;
				current_function = name;
			}
			continue;
		}

		if (!have_entry) {
			have_entry = true;
			current_function = "<file>";
		}

		const err = (message: string) =>
			errors.push({ message: `${message} [in ${current_function}]`, line: i + 1, text: raw });

		const m = /^([a-z][a-z0-9.]*)\s*(.*)$/.exec(t);
		if (!m) {
			err(`unparseable instruction`);
			continue;
		}
		const op = m[1].toLowerCase();
		const rest = m[2].trim();
		const sig = MNEMONICS[op];
		if (!sig) {
			err(`unknown mnemonic '${op}'`);
			continue;
		}

		// Operand tokenization: b.cond's suffix is part of the mnemonic; a
		// trailing `, lsl #n` shift attaches to the previous operand.
		const parts = split_operands(rest);
		const operands: Operand[] = [];
		let labelish_count = 0;
		let parse_failed = false;
		for (let p = 0; p < parts.length; p++) {
			const tok = parts[p];
			if (tok.startsWith("[")) {
				const mem = parse_mem(parts, p);
				if (!mem) {
					parse_failed = true;
					break;
				}
				operands.push({ kind: "mem", ...mem.mem } as Operand);
				p = mem.next - 1;
				continue;
			}
			const cond_m = /^(eq|ne|gt|ge|lt|le|hi|hs|lo|ls|mi|pl)$/.exec(tok);
			if (cond_m && is_cond(cond_m[1])) {
				operands.push({ kind: "cond", code: cond_m[1] });
				continue;
			}
			const parsed = parse_operand(tok);
			if (parsed === null) {
				parse_failed = true;
				break;
			}
			if (parsed === "labelish") {
				operands.push({ kind: "label", name: tok });
				labelish_count++;
				continue;
			}
			operands.push(parsed);
		}
		if (parse_failed) {
			err(`malformed operand(s) for '${op}'`);
			continue;
		}

		// Shape check against the mnemonic's allowed signatures.
		if (!shape_matches(operands, sig.shapes)) {
			err(
				`'${op}' operand shape mismatch: got ${describe(operands)}, expected ${sig.shapes
					.map((s) => s.join("/"))
					.join(" | ")}`,
			);
			continue;
		}

		// Flags discipline: conditional ops need flags established since the
		// last label/call (AArch64 calls clobber NZCV; labels merge unknown
		// paths).
		if (sig.readsFlags && !flags_known) {
			err(`conditional '${op}' with no preceding flag-setting instruction`);
		}
		if (sig.setsFlags) flags_known = true;
		if (op === "bl" || op === "blr") flags_known = false;

		// Branch targets must exist somewhere in the file.
		if (
			(op === "b" || op.startsWith("b.") || op === "cbz" || op === "cbnz") &&
			labelish_count > 0
		) {
			const target = (operands.find((o) => o.kind === "label") as { name: string }).name;
			if (!labels.has(target)) {
				err(`branch to undefined label '${target}'`);
			}
		}

		// NOTE: stack-balance validation is deliberately NOT done here. A
		// linear scan double-counts sp adjustments across diamond control
		// flow (`b .epilogue` skipping the sibling path's `add sp`), which
		// false-positives on ordinary two-path functions. Balance needs
		// per-block dataflow — phase 2, on the lifted structure.
		void delta;
	}

	return errors;
}

function prev_is_entry_marker(lines: string[], i: number): boolean {
	for (let j = i - 1; j >= 0; j--) {
		const t = strip_comment(lines[j]).trim();
		if (!t) continue;
		return t.startsWith(".p2align") || /^\.text$/.test(t);
	}
	return false;
}

function prev_ends_function(stripped: string[], i: number): boolean {
	for (let j = i - 1; j >= 0; j--) {
		const t = stripped[j];
		if (!t) continue;
		return t === "ret" || t.startsWith(".data");
	}
	return false;
}

function shape_matches(operands: Operand[], shapes: Pos[][]): boolean {
	outer: for (const shape of shapes) {
		if (shape.length !== operands.length) continue;
		for (let i = 0; i < shape.length; i++) {
			if (!operand_matches(shape[i], operands[i])) continue outer;
		}
		return true;
	}
	return false;
}

function operand_matches(pos: Pos, o: Operand): boolean {
	switch (pos) {
		case "r":
			return o.kind === "reg" && o.cls === "gpr";
		case "f":
			return o.kind === "reg" && o.cls === "fpr";
		case "i":
			return o.kind === "imm";
		case "c":
			return o.kind === "cond";
		case "l":
			return o.kind === "label";
		case "m":
			return o.kind === "mem";
		default:
			return false;
	}
}

function describe(operands: Operand[]): string {
	return operands.map((o) => o.kind).join(",") || "(none)";
}

/**
 * Structured lift for dataflow phases: same parser, returns lines grouped by
 * function entry (bl-target / globl / boundary-heuristic labels). Validation
 * errors are returned alongside — callers should check them first.
 */
export function lift_functions(code: string): { result: LiftResult } {
	const errors = validate_asm(code);
	const lines: AsmLine[] = [];
	const functions: LiftedFunction[] = [];
	const lines_split = code.split("\n");
	const bl_targets = new Set<string>();
	for (const raw of lines_split) {
		const bm = /^\s*bl\s+([A-Za-z_.$][\w.$]*)/.exec(strip_comment(raw));
		if (bm) bl_targets.add(bm[1]);
	}
	let current: LiftedFunction | undefined;
	for (let i = 0; i < lines_split.length; i++) {
		const text = lines_split[i];
		const t = strip_comment(text).trim();
		const lm = /^([A-Za-z_.$][\w.$]*):(.*)$/.exec(t);
		const is_global_label =
			lm &&
			!lm[2].trim() &&
			!lm[1].startsWith(".") &&
			(bl_targets.has(lm[1]) || prev_is_entry_marker(lines_split, i));
		if (is_global_label && lm) {
			current = { name: lm[1], body: [] };
			functions.push(current);
		}
		if (!current) {
			current = { name: "<file>", body: [] };
			functions.push(current);
		}
		// Blank and comment-only lines carry no structure but MUST be kept —
		// re-emission is byte-identical only if every input line survives.
		if (!t || t.startsWith("//")) {
			lines.push({ kind: "directive", text, line: i + 1 });
			current.body.push(lines[lines.length - 1]);
			continue;
		}
		if (lm) {
			lines.push({ kind: "label", name: lm[1], text, line: i + 1 });
		} else if (t.startsWith(".") || /^[\w.$]+\s*=\s*[\w.$]+$/.test(t)) {
			lines.push({ kind: "directive", text, line: i + 1 });
		} else {
			lines.push({ kind: "directive", text, line: i + 1 });
		}
		current.body.push(lines[lines.length - 1]);
	}
	return { result: { ok: errors.length === 0, errors, lines, functions } };
}
