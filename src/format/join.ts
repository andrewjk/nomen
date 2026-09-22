import { KEYWORDS } from "../keywords.ts";
import type { Piece } from "./scan.ts";

// Words that are never a call target, so `(`, `[` and `.` keep a space after
// them. Re-exported for existing importers; the parser's reserved-word check
// uses the canonical set in src/keywords.ts.
export { KEYWORDS };
// Keywords that open a call or declaration and so bind tightly to `(` with no
// space: `func f(...)`, `struct S(...)`, `cast x as int`, `panic("...")`.
// Control-flow keywords (`if`, `while`, `return`, ...) keep a space: `if (...)`.
const CALL_KEYWORDS = new Set([
	"func",
	"struct",
	"class",
	"trait",
	"enum",
	"bitset",
	"cast",
	"panic",
	"todo",
]);

const NO_SPACE_BEFORE = new Set([",", ";", ")", "]", ":", "?", "::"]);
const NO_SPACE_AFTER = new Set(["(", "[", ".", "#", "...", "!", "???", "!!!", "::"]);
// `<` and `>` are both generic brackets and comparisons, `>>` is both a
// nested-generic closer (`List<List<int>>`) and a shift, and `..` is written
// either `0..3` or `0 .. 3`. Rather than guess, keep whatever was written.
const KEEP_SPACING = new Set(["<", ">", ">>", ".."]);

// After these, a `+` or `-` is a sign rather than a subtraction. Getting this
// wrong changes the token stream (`a -1` is not `a - 1`), which the safety
// check in `format` catches.
const PREFIX_POSITIONS = new Set([
	"(",
	"[",
	"{",
	",",
	";",
	":",
	"=",
	"==",
	"!=",
	">=",
	"<=",
	"<",
	">",
	"+",
	"-",
	"*",
	"/",
	"%",
	"&&",
	"||",
	"??",
	"+=",
	"-=",
	"*=",
	"->",
	"=>",
	"..",
	"&",
	"|",
	"^",
	"<<",
	">>",
	"!",
]);

/** Render a line's pieces with normalized spacing. */
export default function join(pieces: Piece[]): string {
	let out = "";
	for (let i = 0; i < pieces.length; i++) {
		if (i > 0 && needs_space(pieces, i)) out += " ";
		out += pieces[i].text;
	}
	return out;
}

function needs_space(pieces: Piece[], i: number): boolean {
	const previous = pieces[i - 1];
	const current = pieces[i];

	if (KEEP_SPACING.has(current.text) || KEEP_SPACING.has(previous.text)) {
		return current.space_before;
	}
	if (NO_SPACE_BEFORE.has(current.text)) return false;
	// A prefix symbol has nothing to attach to when a block ends after it.
	if (current.text === "}") return true;
	if (NO_SPACE_AFTER.has(previous.text)) return false;
	// `out`/`in` are parameter modifiers: `out int x`, `for x in (...)`, but
	// `out.length` keeps the dot tight.
	if (previous.text === "out" || previous.text === "in") return current.text !== ".";
	if (is_sign(pieces, i - 1)) return false;
	// `a.b` binds tight, but the enum shorthand `.north` is a value of its own.
	if (current.text === ".") return !is_value_end(pieces, i - 1);
	// `func(...)`, `cast (...)`, `panic("...")` bind tight; control-flow
	// keywords keep a space: `if (...)`, `return (...)`.
	if (current.text === "(" || current.text === "[")
		return !is_value_end(pieces, i - 1) && !CALL_KEYWORDS.has(previous.text);
	// Keep a comment glued to the code when the source had no space before it.
	if (current.kind === "comment") return current.space_before;
	return true;
}

/** Is the piece at `i` a sign (`-5`) rather than an operator (`a - 5`)? */
export function is_sign(pieces: Piece[], i: number): boolean {
	const piece = pieces[i];
	if (piece.text !== "-" && piece.text !== "+") return false;
	const previous = pieces[i - 1];
	if (!previous) return true;
	if (PREFIX_POSITIONS.has(previous.text)) return true;
	return previous.kind === "word" && KEYWORDS.has(previous.text);
}

/**
 * Can the piece at `i` end a value, so that a following `(`, `[` or `.` binds
 * to it? A word after `.` is a member name, so it binds even when it spells a
 * keyword (`old_keys.move(i)`).
 */
export function is_value_end(pieces: Piece[], i: number): boolean {
	const piece = pieces[i];
	switch (piece.kind) {
		case "number":
		case "string":
		case "char":
			return true;
		case "word":
			if (i > 0 && pieces[i - 1].text === ".") return true;
			return !KEYWORDS.has(piece.text);
		case "symbol":
			return piece.text === ")" || piece.text === "]" || piece.text === ">" || piece.text === "?";
		default:
			return false;
	}
}
