import { is_raw_directive_at, scan_raw_body_end } from "../raw_block.ts";
import { COMPOUND_SYMBOLS, LONG_COMPOUND_SYMBOLS } from "../tokenize.ts";

export type PieceKind = "word" | "number" | "string" | "char" | "comment" | "symbol";

/** One token of a line, plus whether the source had whitespace before it. */
export interface Piece {
	kind: PieceKind;
	text: string;
	space_before: boolean;
	/** The exact whitespace run before this piece ("" when glued). Trailing
	 *  comments keep it: alignment between code and its comment is meaningful
	 *  and must survive formatting. */
	gap_before?: string;
}

export type LineKind =
	/** A line of code, broken into pieces. */
	| "code"
	/** An empty line. */
	| "blank"
	/** Inside a raw block or a multi-line string — emitted exactly as written. */
	| "verbatim"
	/** A continuation line of a block comment — re-indented, never re-wrapped. */
	| "comment";

export interface Line {
	kind: LineKind;
	pieces: Piece[];
	text: string;
}

interface ScanState {
	comment_depth: number;
}

/**
 * Split source into lines of pieces. Raw blocks span lines and hold assembly
 * or C, which must not be touched — their lines are marked verbatim in a
 * pre-pass (`raw_verbatim_lines`). Block comments span lines too, so a small
 * amount of state is carried between them; everything else is scanned a line
 * at a time.
 */
export default function scan(source: string): Line[] {
	const state: ScanState = { comment_depth: 0 };
	const raw_lines = raw_verbatim_lines(source);
	return source
		.split("\n")
		.map((text, index) => (raw_lines.has(index) ? verbatim(text) : scan_line(text, state)));
}

function scan_line(text: string, state: ScanState): Line {
	if (state.comment_depth > 0) {
		state.comment_depth += count_comment_delimiters(text, 0);
		return { kind: "comment", pieces: [], text };
	}

	const pieces: Piece[] = [];
	let gap = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (is_space(c)) {
			gap += c;
			i++;
			continue;
		}

		const start = i;
		let kind: PieceKind = "symbol";
		if (c === "/" && text[i + 1] === "/") {
			kind = "comment";
			i = text.length;
		} else if (c === "/" && text[i + 1] === "*") {
			kind = "comment";
			const depth = count_comment_delimiters(text, i);
			if (depth > 0) {
				state.comment_depth = depth;
				i = text.length;
			} else {
				i = end_of_block_comment(text, i);
			}
		} else if (c === '"') {
			// An unterminated string opens a multi-line string: leave the rest
			// of the line verbatim so its contents are never reformatted.
			const close = end_of_string(text, i);
			if (close === i) return verbatim(text);
			kind = "string";
			i = close;
		} else if (c === "'") {
			kind = "char";
			i = end_of_char(text, i);
		} else if (is_digit(c)) {
			kind = "number";
			i = end_of_number(text, i);
		} else if (is_word_char(c)) {
			kind = "word";
			while (i < text.length && is_word_char(text[i])) i++;
		} else {
			i += symbol_length(text, i);
		}

		pieces.push({
			kind,
			text: text.slice(start, i),
			space_before: gap.length > 0,
			gap_before: gap,
		});
		gap = "";
	}

	if (!pieces.length) return { kind: "blank", pieces: [], text: "" };
	return { kind: "code", pieces, text };
}

function verbatim(text: string): Line {
	return { kind: "verbatim", pieces: [], text };
}

/**
 * Lines covered by `#raw` constructs — from the directive line through the
 * line holding the body's closing `}`. Those lines are emitted exactly as
 * written (the body is C/assembly; the opener's shape is the author's).
 *
 * The scan is the same brace-aware walk the tokenizer uses
 * (`scan_raw_body_end`), so the formatter and the compiler can never disagree
 * about where a block ends. Strings and comments are stepped over while
 * looking for the opener — a `#raw` inside a string is just text.
 */
function raw_verbatim_lines(source: string): Set<number> {
	const lines = new Set<number>();
	let line = 0;
	let i = 0;
	const newlines_in = (from: number, to: number): number => {
		let count = 0;
		for (let k = from; k < to; k++) if (source[k] === "\n") count++;
		return count;
	};
	while (i < source.length) {
		const c = source[i];
		if (c === "\n") {
			line++;
			i++;
			continue;
		}
		if (c === '"' || c === "'") {
			const quote = c;
			i++;
			while (i < source.length) {
				if (source[i] === "\\") {
					i += 2;
					continue;
				}
				if (source[i] === quote || source[i] === "\n") {
					if (source[i] === quote) i++;
					break;
				}
				i++;
			}
			continue;
		}
		if (c === "/" && source[i + 1] === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && source[i + 1] === "*") {
			i += 2;
			while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
				if (source[i] === "\n") line++;
				i++;
			}
			i += 2;
			continue;
		}
		if (is_raw_directive_at(source, i)) {
			// Skip to the opening brace: optional `(...)` arguments first.
			let k = i + 4;
			const skip_space = () => {
				while (
					k < source.length &&
					(source[k] === " " || source[k] === "\t" || source[k] === "\n")
				) {
					if (source[k] === "\n") line++;
					k++;
				}
			};
			skip_space();
			if (source[k] === "(") {
				k++;
				while (k < source.length && source[k] !== ")") {
					if (source[k] === '"') {
						k++;
						while (k < source.length && source[k] !== '"') {
							if (source[k] === "\\") k++;
							k++;
						}
					}
					if (source[k] === "\n") line++;
					k++;
				}
				k++;
				skip_space();
			}
			if (source[k] === "{") {
				const close = scan_raw_body_end(source, k + 1);
				const start_line = line;
				line += newlines_in(k, Math.min(close, source.length));
				for (let l = start_line; l <= line; l++) lines.add(l);
				i = close + 1;
				continue;
			}
			i = k;
			continue;
		}
		i++;
	}
	return lines;
}

// The change in block comment nesting across `text` from `from` onwards.
function count_comment_delimiters(text: string, from: number): number {
	let depth = 0;
	for (let i = from; i < text.length; i++) {
		if (text[i] === "/" && text[i + 1] === "*") {
			depth += 1;
			i++;
		} else if (text[i] === "*" && text[i + 1] === "/") {
			depth -= 1;
			i++;
		}
	}
	return depth;
}

function end_of_block_comment(text: string, from: number): number {
	let depth = 0;
	for (let i = from; i < text.length; i++) {
		if (text[i] === "/" && text[i + 1] === "*") {
			depth += 1;
			i++;
		} else if (text[i] === "*" && text[i + 1] === "/") {
			depth -= 1;
			if (depth === 0) return i + 2;
			i++;
		}
	}
	return text.length;
}

// A string runs to its closing quote, stepping over escapes and `\{ }`
// interpolations (which may themselves contain quotes). An unterminated string
// is a multi-line string: leave the rest of the line verbatim rather than
// splitting it into pieces, so reformatting never touches its contents.
function end_of_string(text: string, from: number): number {
	for (let i = from + 1; i < text.length; i++) {
		if (text[i] === "\\" && text[i + 1] === "{") {
			i = end_of_interpolation(text, i + 1) - 1;
		} else if (text[i] === '"' && text[i - 1] !== "\\") {
			return i + 1;
		}
	}
	return from;
}

function end_of_interpolation(text: string, from: number): number {
	let depth = 0;
	for (let i = from; i < text.length; i++) {
		if (text[i] === "{") depth += 1;
		else if (text[i] === "}") {
			depth -= 1;
			if (depth === 0) return i + 1;
		}
	}
	return text.length;
}

function end_of_char(text: string, from: number): number {
	for (let i = from + 1; i < text.length; i++) {
		if (text[i] === "\\") {
			i++;
			continue;
		}
		if (text[i] === "'") return i + 1;
	}
	return from + 1;
}

// Numbers keep their radix prefix, digit separators, decimal part and exponent
// in one piece, so no spacing rule can ever split them.
function end_of_number(text: string, from: number): number {
	let i = from;
	const prefix = text.slice(i, i + 2).toLowerCase();
	if (prefix === "0x" || prefix === "0o" || prefix === "0b") {
		i += 2;
		while (i < text.length && (is_word_char(text[i]) || text[i] === "_")) i++;
		return i;
	}
	while (i < text.length && (is_digit(text[i]) || text[i] === "_")) i++;
	if (text[i] === "." && is_digit(text[i + 1])) {
		i++;
		while (i < text.length && (is_digit(text[i]) || text[i] === "_")) i++;
	}
	if ((text[i] === "e" || text[i] === "E") && is_exponent(text, i + 1)) {
		i += text[i + 1] === "+" || text[i + 1] === "-" ? 2 : 1;
		while (i < text.length && is_digit(text[i])) i++;
	}
	return i;
}

function is_exponent(text: string, i: number): boolean {
	if (text[i] === "+" || text[i] === "-") return is_digit(text[i + 1]);
	return is_digit(text[i]);
}

function symbol_length(text: string, i: number): number {
	if (LONG_COMPOUND_SYMBOLS.includes(text.slice(i, i + 3))) return 3;
	if (COMPOUND_SYMBOLS.includes(text.slice(i, i + 2))) return 2;
	return 1;
}

function is_space(c: string): boolean {
	return c === " " || c === "\t" || c === "\r" || c === "\v" || c === "\f";
}

function is_digit(c: string): boolean {
	return c >= "0" && c <= "9";
}

function is_word_char(c: string): boolean {
	return (c >= "0" && c <= "9") || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
}
