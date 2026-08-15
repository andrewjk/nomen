import join, { is_value_end, KEYWORDS } from "./format/join.ts";
import scan from "./format/scan.ts";
import type { Line, Piece } from "./format/scan.ts";
import tokenize from "./tokenize.ts";

export interface FormatOptions {
	/** The column to wrap argument lists at. */
	print_width: number;
	/** Sort each run of `import` lines alphabetically. */
	sort_imports: boolean;
	/** Indent with tabs rather than spaces. */
	use_tabs: boolean;
	/** Keep a trailing comma on multi-line array literals (the only place the
	 *  grammar allows one). */
	trailing_comma: boolean;
	/** Drop declared types the value already states, e.g. `var Text t = Text(w)`. */
	strip_redundant_types: boolean;
	/** How wide a tab is, when measuring against `print_width`. */
	tab_width: number;
}

export const default_format_options: FormatOptions = {
	print_width: 100,
	sort_imports: true,
	use_tabs: true,
	trailing_comma: true,
	strip_redundant_types: true,
	tab_width: 4,
};

export interface FormatResult {
	code: string;
	changed: boolean;
	/** Set when formatting was abandoned because it would have changed the code. */
	unsafe?: string;
}

// Operators that leave a statement unfinished, so the next line is a continuation.
const CONTINUES_LINE = new Set([
	"=",
	"+",
	"-",
	"*",
	"/",
	"%",
	"==",
	"!=",
	">=",
	"<=",
	"&&",
	"||",
	"??",
	"+=",
	"-=",
	"*=",
	"->",
	"=>",
	"&",
	"|",
	"^",
	"<<",
	">>",
	":",
]);

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Format Nomen source. Returns the original source if formatting is unsafe. */
export default function format(source: string, options?: Partial<FormatOptions>): string {
	return format_source(source, options).code;
}

/**
 * Format Nomen source, reporting whether anything changed.
 *
 * Layout is checked against the tokenizer before it is handed back: if the
 * formatted source doesn't tokenize to exactly the same stream, the original is
 * returned untouched. Nomen's tokenizer folds a sign into the number that
 * follows it (`a -1` is not `a - 1`), so a spacing slip really can change the
 * meaning of a program — never let one through. Pass `force` to apply the
 * layout anyway (e.g. for an explicit "force format" command).
 */
export function format_source(
	source: string,
	options?: Partial<FormatOptions>,
	force = false,
): FormatResult {
	const config = { ...default_format_options, ...options };
	const lines = scan(source);

	// Check the layout on its own: sorting imports and dropping redundant types
	// move tokens around on purpose, so they can't be part of the comparison.
	const layout = render(lines, { ...config, strip_redundant_types: false });
	const difference = token_difference(source, layout);
	if (difference && !force) return { code: source, changed: false, unsafe: difference };

	if (config.sort_imports) sort_imports(lines);
	const code = config.sort_imports || config.strip_redundant_types ? render(lines, config) : layout;
	return { code, changed: code !== source };
}

function render(lines: Line[], options: FormatOptions): string {
	const out: string[] = [];
	const brackets: { text: string; is_list: boolean }[] = [];
	let previous: Piece[] | undefined;
	let pending_blank = false;

	for (const line of lines) {
		if (line.kind === "blank") {
			pending_blank = out.length > 0;
			continue;
		}
		if (pending_blank) {
			out.push("");
			pending_blank = false;
		}

		if (line.kind === "verbatim") {
			out.push(line.text.replace(/\s+$/, ""));
			continue;
		}
		if (line.kind === "comment") {
			const text = line.text.trim();
			// Line up the ` * ` of a block comment under the ` /* ` that opened it.
			out.push(
				text ? indent(brackets.length, options) + (text.startsWith("*") ? " " : "") + text : "",
			);
			continue;
		}

		let pieces = line.pieces;
		if (options.strip_redundant_types) pieces = strip_redundant_type(pieces);

		const closes = CLOSERS.has(pieces[0].text);
		let level = closes ? Math.max(0, brackets.length - 1) : brackets.length;
		if (!closes && is_continuation(previous, pieces)) level += 1;

		if (closes) fix_trailing_comma(out, brackets.at(-1), options);
		out.push(...wrap(pieces, level, options));

		for (let i = 0; i < pieces.length; i++) {
			const text = pieces[i].text;
			if (OPENERS.has(text)) brackets.push({ text, is_list: is_list_open(pieces, i) });
			else if (CLOSERS.has(text) && brackets.length) brackets.pop();
		}
		previous = pieces;
	}

	while (out.length && !out[out.length - 1]) out.pop();
	return out.length ? out.join("\n") + "\n" : "";
}

// --- Layout ------------------------------------------------------------------

function indent(level: number, options: FormatOptions): string {
	return options.use_tabs ? "\t".repeat(level) : " ".repeat(level * options.tab_width);
}

function is_continuation(previous: Piece[] | undefined, pieces: Piece[]): boolean {
	if (!previous) return false;
	const last = previous[previous.length - 1];
	if (last.kind === "symbol" && CONTINUES_LINE.has(last.text)) return true;
	const first = pieces[0];
	// A chained call, or the arms of an `if` expression, e.g.
	//   const label = if north -> "N"
	//       else -> "S"
	// The `else` of a block, or of a `match`/`switch` arm, is not a continuation.
	if (first.text === "." || first.text === "->") return true;
	if (first.text === "else") {
		return last.text !== "}" && !OPENERS.has(last.text) && previous[0].text !== "case";
	}
	return false;
}

/** Emit a line, breaking its bracketed list up if it is over the print width. */
function wrap(pieces: Piece[], level: number, options: FormatOptions): string[] {
	const text = join(pieces);
	const width = level * options.tab_width + text.length;
	if (width <= options.print_width) return [indent(level, options) + text];

	const group = find_group(pieces);
	if (!group) return [indent(level, options) + text];
	const items = split_items(pieces.slice(group.open + 1, group.close));
	if (items.length < 2) return [indent(level, options) + text];

	// Parameter lists are never `is_list`, so this only adds the comma to array
	// literals and argument lists; a reflowed parameter list keeps no trailing
	// comma (any written one is stripped on the closing line).
	const trailing = options.trailing_comma && group.is_list;

	const out = [indent(level, options) + join(pieces.slice(0, group.open + 1))];
	items.forEach((item, index) => {
		const last = index === items.length - 1;
		const with_comma = !last || trailing ? [...item, comma_piece()] : [...item];
		out.push(...wrap(with_comma, level + 1, options));
	});
	out.push(indent(level, options) + join(pieces.slice(group.close)));
	return out;
}

/** The first bracket group on the line that opens and closes there and holds a list. */
function find_group(
	pieces: Piece[],
): { open: number; close: number; is_list: boolean } | undefined {
	for (let i = 0; i < pieces.length; i++) {
		if (!OPENERS.has(pieces[i].text)) continue;
		const close = match_bracket(pieces, i);
		if (close < 0) continue;
		if (split_items(pieces.slice(i + 1, close)).length < 2) continue;
		return { open: i, close, is_list: is_list_open(pieces, i) };
	}
	return undefined;
}

function match_bracket(pieces: Piece[], open: number): number {
	let depth = 0;
	for (let i = open; i < pieces.length; i++) {
		if (OPENERS.has(pieces[i].text)) depth += 1;
		else if (CLOSERS.has(pieces[i].text)) {
			depth -= 1;
			if (depth === 0) return pieces[i].text === PAIRS[pieces[open].text] ? i : -1;
		}
	}
	return -1;
}

/**
 * The commas that separate the top-level items of a bracket group. Commas
 * inside nested brackets are not separators, and neither are the ones inside
 * `<...>` type arguments (`Map<string, int>` is one item, not two). A `<`
 * after a name opens type arguments; if no matching closer follows before the
 * group ends, the angle brackets were really comparisons, so the scan is
 * redone ignoring them.
 */
function separator_cuts(pieces: Piece[]): number[] {
	const cuts: number[] = [];
	let depth = 0;
	let angles = 0;
	let previous: Piece | undefined;
	for (let i = 0; i < pieces.length; i++) {
		const text = pieces[i].text;
		if (OPENERS.has(text)) depth += 1;
		else if (CLOSERS.has(text)) depth -= 1;
		else if (text === "<" && is_name(previous)) angles += 1;
		else if (angles > 0 && text === ">") angles -= 1;
		else if (angles > 0 && text === ">>") angles = Math.max(0, angles - 2);
		else if (text === "," && depth === 0 && angles === 0) cuts.push(i);
		previous = pieces[i];
	}
	// An angle bracket that never closed was a comparison, not a type list.
	return angles > 0 ? separator_cuts_fallback(pieces) : cuts;
}

/** The bracket-only scan, for angle brackets that never closed. */
function separator_cuts_fallback(pieces: Piece[]): number[] {
	const cuts: number[] = [];
	let depth = 0;
	for (let i = 0; i < pieces.length; i++) {
		const text = pieces[i].text;
		if (OPENERS.has(text)) depth += 1;
		else if (CLOSERS.has(text)) depth -= 1;
		else if (text === "," && depth === 0) cuts.push(i);
	}
	return cuts;
}

function split_items(pieces: Piece[]): Piece[][] {
	const items: Piece[][] = [];
	const cuts = [...separator_cuts(pieces), pieces.length];
	for (let i = 0; i < cuts.length; i++) {
		const item = pieces.slice(i === 0 ? 0 : cuts[i - 1] + 1, cuts[i]);
		if (item.length) items.push(item);
	}
	return items;
}

/** Is the bracket at `i` a multi-item list — an array literal or an argument list? */
function is_list_open(pieces: Piece[], i: number): boolean {
	const bracket = pieces[i].text;
	if (bracket === "(") {
		// An argument list: `f(...)`, `Array<T>(...)`. A parameter list
		// (`func g = (...)`) never takes a trailing comma in Nomen, and a cast
		// (`x as int`) is a single value — so only a `(` preceded by a value
		// (a call or construction) is a list.
		const previous = pieces[i - 1];
		return !!previous && is_value_end(previous) && previous.text !== "=";
	}
	if (bracket === "[") {
		const previous = pieces[i - 1];
		// `var [a, b] = pair` is a destructuring pattern, not a list.
		if (previous?.kind === "word" && KEYWORDS.has(previous.text)) return false;
		return !previous || !is_value_end(previous);
	}
	return false;
}

function comma_piece(): Piece {
	return { kind: "symbol", text: ",", space_before: false };
}

// Add or remove the trailing comma on the item line above a closing bracket.
function fix_trailing_comma(
	out: string[],
	bracket: { text: string; is_list: boolean } | undefined,
	options: FormatOptions,
): void {
	const previous = out[out.length - 1];
	if (!bracket || !previous) return;
	const trimmed = previous.trimEnd();
	if (!trimmed || OPENERS.has(trimmed[trimmed.length - 1])) return;
	if (options.trailing_comma && bracket.is_list) {
		if (!trimmed.endsWith(",")) out[out.length - 1] = trimmed + ",";
	} else if (trimmed.endsWith(",")) {
		out[out.length - 1] = trimmed.slice(0, -1);
	}
}

// --- Imports -----------------------------------------------------------------

function sort_imports(lines: Line[]): void {
	for (let i = 0; i < lines.length; i++) {
		if (!is_import(lines[i])) continue;
		let end = i;
		while (end + 1 < lines.length && is_import(lines[end + 1])) end++;
		if (end > i) {
			const run = lines
				.slice(i, end + 1)
				.sort((a, b) => (join(a.pieces) < join(b.pieces) ? -1 : 1));
			lines.splice(i, end - i + 1, ...run);
		}
		i = end;
	}
}

function is_import(line: Line): boolean {
	return line.kind === "code" && line.pieces[0]?.text === "import";
}

// --- Redundant types ---------------------------------------------------------

/**
 * Drop a declared type that the value repeats:
 *   `var Text title = Text(win)` → `var title = Text(win)`
 *   `var string name = "Andrew"` → `var name = "Andrew"`
 *
 * Only the two forms above are recognised, because everything else relies on
 * inference rules that a text transform can't see — `var float f = 5` and
 * `var Direction d = .east` must both keep their types.
 */
function strip_redundant_type(pieces: Piece[]): Piece[] {
	let i = 0;
	if (pieces[i]?.text === "pub" || pieces[i]?.text === "private") i++;
	const declaration = pieces[i]?.text;
	if (declaration !== "var" && declaration !== "const" && declaration !== "mov") return pieces;
	i++;

	const type_start = i;
	if (!is_name(pieces[i])) return pieces;
	i++;
	if (pieces[i]?.text === "<") {
		i = match_bracket_text(pieces, i, "<", ">");
		if (i < 0) return pieces;
		i++;
	}
	const type_end = i;

	if (!is_name(pieces[i])) return pieces;
	i++;
	if (pieces[i]?.text !== "=") return pieces;
	i++;

	let value = pieces.slice(i);
	while (value.length && value[value.length - 1].kind === "comment") value = value.slice(0, -1);
	if (!value.length) return pieces;

	const type = pieces.slice(type_start, type_end);
	if (!is_redundant(type, value)) return pieces;
	return [...pieces.slice(0, type_start), ...pieces.slice(type_end)];
}

function is_redundant(type: Piece[], value: Piece[]): boolean {
	// `var T x = T(...)` with a non-generic, identical constructor is safe to
	// strip: the type is exactly the constructed type. Nomen can't infer a
	// variable's type from a generic constructor call, so those are kept.
	if (value.length > type.length && value[type.length].text === "(") {
		const close = match_bracket(value, type.length);
		if (close === value.length - 1) {
			const constructor = value.slice(0, type.length);
			if (!constructor.some((piece) => piece.text === "<" || piece.text === ">")) {
				if (type.every((piece, index) => piece.text === constructor[index].text)) return true;
			}
		}
	}
	// `var T x = <literal>`: strip when the literal unambiguously infers exactly
	// `T`. `uint` stays (a bare `0` can't be known to be unsigned).
	if (value.length === 1 && type.length === 1) {
		return literal_type(value[0]) === type[0].text && SAFE_LITERAL_TYPES.has(type[0].text);
	}
	return false;
}

const SAFE_LITERAL_TYPES = new Set(["int", "float", "string", "char", "bool"]);

function literal_type(piece: Piece): string | undefined {
	switch (piece.kind) {
		case "string":
			return "string";
		case "char":
			return "char";
		case "number":
			return piece.text.includes(".") ? "float" : "int";
		case "word":
			return piece.text === "true" || piece.text === "false" ? "bool" : undefined;
		default:
			return undefined;
	}
}

function is_name(piece: Piece | undefined): boolean {
	return !!piece && piece.kind === "word" && !KEYWORDS.has(piece.text);
}

function match_bracket_text(pieces: Piece[], open: number, opener: string, closer: string): number {
	let depth = 0;
	for (let i = open; i < pieces.length; i++) {
		if (pieces[i].text === opener) depth += 1;
		else if (pieces[i].text === closer) {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

// --- Safety ------------------------------------------------------------------

/** A description of the first token that formatting would have changed, if any. */
function token_difference(source: string, formatted: string): string | undefined {
	const before = significant_tokens(source);
	const after = significant_tokens(formatted);
	const length = Math.max(before.length, after.length);
	for (let i = 0; i < length; i++) {
		if (before[i] === after[i]) continue;
		return `token ${i + 1} would change from ${describe(before[i])} to ${describe(after[i])}`;
	}
	return undefined;
}

function significant_tokens(source: string): string[] {
	const tokens = tokenize(source).map((token) => token.value);
	// A trailing comma is layout, not code, so ignore the ones we add or remove.
	return tokens.filter(
		(token, i) => !(token === "," && [")", "]", "}"].includes(tokens[i + 1] ?? "")),
	);
}

function describe(token: string | undefined): string {
	return token === undefined ? "nothing" : JSON.stringify(token);
}
