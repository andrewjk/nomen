import { KEYWORDS, RESERVED_WORDS } from "../keywords.ts";
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
// `!` is triple-role — prefix not (`!ready`), postfix propagate (`expr!`),
// and the infix result-form separator (`T ! E`) — so its spacing is decided
// by ROLE, not by the author's whitespace: the separator canonicalizes to
// SPEC's spaced spelling (`T ! E`), and the operator roles stay tight (an
// early formatter guessed by whitespace and squashed `out int ! MathError`
// to `out int !MathError` — a role-first rule cannot repeat that).
const NO_SPACE_AFTER = new Set(["(", "[", ".", "#", "...", "::"]);
// `<` and `>` are both generic brackets and comparisons, `>>` is both a
// nested-generic closer (`List<List<int>>`) and a shift, and `..` is written
// either `0..3` or `0 .. 3` — rather than guess, keep whatever was written.
// (`!` left this set: its spacing is now role-decided — see `bang_spacing`.)
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
	"?.",
	"!!",
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
		if (i > 0) {
			// A trailing comment keeps the author's gap verbatim: column
			// alignment between code and its comment is meaningful, so the
			// formatter must not collapse it to a single space.
			if (pieces[i].kind === "comment") {
				out += pieces[i].gap_before ?? (pieces[i].space_before ? " " : "");
			} else if (needs_space(pieces, i)) {
				out += " ";
			}
		}
		out += pieces[i].text;
	}
	return out;
}

function needs_space(pieces: Piece[], i: number): boolean {
	const previous = pieces[i - 1];
	const current = pieces[i];

	// A single `!` decides spacing on BOTH sides by role, so it is handled
	// for itself (space before) and for the piece that follows it.
	if (current.text === "!") return space_before_bang(pieces, i);
	if (previous.text === "!") return space_after_bang(pieces, i);
	if (KEEP_SPACING.has(current.text) || KEEP_SPACING.has(previous.text)) {
		return current.space_before;
	}
	if (NO_SPACE_BEFORE.has(current.text)) return false;
	// `{}` stays tight (an empty block, or a `ref x {}` field set); a closing
	// brace after content keeps its separating space.
	if (current.text === "}") return previous.text !== "{";
	// A `#` name splice binds tight to the name it splices (`# field` is a
	// different, unparseable program). After a KEYWORD the space follows the
	// ordinary rules (`var #{field.name}`); after a plain word the `#` is a
	// PREFIX splice inside the name (`func get_#{field.name}`) — tight. And
	// the name the splice reads never gains a leading space (`#` is already
	// in NO_SPACE_AFTER).
	const previous_is_word = /^[A-Za-z_]\w*$/.test(previous.text);
	if (current.text === "#" && previous_is_word && !RESERVED_WORDS.has(previous.text)) {
		return false;
	}
	if (NO_SPACE_AFTER.has(previous.text)) return false;
	// `out`/`in` are parameter modifiers: `out int x`, `for x in (...)`, but
	// `out.length` keeps the dot tight.
	if (previous.text === "out") return current.text !== ".";
	if (is_sign(pieces, i - 1)) return false;
	// `a.b` binds tight, but the enum shorthand `.north` is a value of its own.
	if (current.text === ".") return !is_value_end(pieces, i - 1);
	// `func(...)`, `cast (...)`, `panic("...")` bind tight; control-flow
	// keywords keep a space: `if (...)`, `return (...)`.
	if (current.text === "(" || current.text === "[")
		return !is_value_end(pieces, i - 1) && !CALL_KEYWORDS.has(previous.text);
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
 * The role of the single `!` at `i`, decided by SHAPE, never by the author's
 * whitespace:
 *
 * - **infix** — the result-form separator: a value end on the left and a
 *   word on the right (`int ! E`, `int!E`). Canonicalized to SPEC's spaced
 *   spelling, spaces on both sides.
 * - **prefix** — not: an operand word or `(` follows (`!ready`, `!(a)`).
 * - **postfix** — propagate: a value end on the left and no word on the
 *   right (`close(path)!`, `expr!` at a line end).
 *
 * Spacing never changes the token stream (`!E` and `! E` tokenize alike),
 * so a misread role is cosmetic at worst — the safety check in `format`
 * still guards the sign-folding cases that CAN change meaning. (The
 * whitespace-guessing era squashed `out int ! MathError` to
 * `out int !MathError`; a shape-first rule cannot repeat that.)
 */
function bang_role(pieces: Piece[], i: number): "infix" | "prefix" | "postfix" | "author" {
	const previous = pieces[i - 1];
	const next = pieces[i + 1];
	// `out ! E` (and the `T ! E` form) — after the out modifier, `!` is
	// always the result-form separator, never prefix-not.
	if (previous?.text === "out") return "infix";
	if (i > 0 && is_value_end(pieces, i - 1)) {
		// An operand word follows (`int ! E`) — but a KEYWORD word (`expr!
		// catch`) is a continuation, so the `!` is postfix propagate.
		const operand_follows = !!next && next.kind === "word" && !KEYWORDS.has(next.text);
		return operand_follows ? "infix" : "postfix";
	}
	if (next && (next.kind === "word" || next.text === "(")) return "prefix";
	return "author";
}

function space_before_bang(pieces: Piece[], i: number): boolean {
	if (bang_role(pieces, i) === "infix") return true;
	// Every other role keeps the author's gap — the operators' tight
	// spellings are already written tight (`!ready`, `a(p)!`).
	return pieces[i].space_before;
}

function space_after_bang(pieces: Piece[], i: number): boolean {
	const role = bang_role(pieces, i - 1);
	if (role === "infix") return true;
	if (role === "prefix") return false;
	// Postfix (and anything unrecognized) keeps the author's gap after the
	// `!` — the following piece is usually a closer, comma, or keyword.
	return pieces[i].space_before;
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
