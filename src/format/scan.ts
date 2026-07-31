import { COMPOUND_SYMBOLS, LONG_COMPOUND_SYMBOLS } from "../tokenize.ts";

export type PieceKind = "word" | "number" | "string" | "char" | "comment" | "symbol";

/** One token of a line, plus whether the source had whitespace before it. */
export interface Piece {
	kind: PieceKind;
	text: string;
	space_before: boolean;
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
	in_raw: boolean;
	comment_depth: number;
}

/**
 * Split source into lines of pieces. Raw blocks and block comments span lines,
 * so a small amount of state is carried between them; everything else is
 * scanned a line at a time.
 */
export default function scan(source: string): Line[] {
	const state: ScanState = { in_raw: false, comment_depth: 0 };
	return source.split("\n").map((text) => scan_line(text, state));
}

function scan_line(text: string, state: ScanState): Line {
	// Raw blocks (``` ... ```) hold assembly or C, which we must not touch. A
	// line that opens or closes one is left alone too, so the fences stay put.
	if (state.in_raw) {
		if (text.includes("```")) state.in_raw = false;
		return verbatim(text);
	}
	if (state.comment_depth > 0) {
		state.comment_depth += count_comment_delimiters(text, 0);
		return { kind: "comment", pieces: [], text };
	}
	if (text.includes("```")) {
		// An opening fence with no closing fence on the same line.
		if (text.indexOf("```") === text.lastIndexOf("```")) state.in_raw = true;
		return verbatim(text);
	}

	const pieces: Piece[] = [];
	let space_before = false;
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (is_space(c)) {
			space_before = true;
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

		pieces.push({ kind, text: text.slice(start, i), space_before });
		space_before = false;
	}

	if (!pieces.length) return { kind: "blank", pieces: [], text: "" };
	return { kind: "code", pieces, text };
}

function verbatim(text: string): Line {
	return { kind: "verbatim", pieces: [], text };
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
