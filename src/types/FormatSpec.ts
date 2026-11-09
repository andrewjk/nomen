/**
 * A compile-time format spec on a string interpolation argument:
 * `\{expr:spec}`. Parsed by the tokenizer/parse layer (which splits the raw
 * text after the expression's top-level `:`), validated against the
 * expression's type during checking, and lowered to a System `Format.*` call
 * that renders the argument before the interpolation helper sees it.
 *
 * Grammar (after the `:`, all parts optional, at most one of each):
 *
 *   spec      := fill? width? precision? base?
 *   fill      := '<' (left-align) | '>' (right-align) | '0' (zero-pad)
 *   width     := digit+
 *   precision := '.' digit+
 *   base      := 'x' | 'X' | 'b' | 'o'
 *
 * - `<` / `>` pad the rendering with spaces to `width`; `0` zero-pads
 *   (integers/floats only, right-align only).
 * - `.N` renders a float with N decimal places (fixed notation).
 * - `x` / `X` render an integer as hexadecimal (lower/upper), `b` binary,
 *   `o` octal.
 */
export default interface FormatSpec {
	/** Left- or right-align the rendering in `width` spaces. Absent = right
	 *  (the default when a width is given). */
	align?: "left" | "right";
	/** Zero-pad (`0` fill). Integers and floats only — checked. */
	zero?: boolean;
	/** Minimum field width. */
	width?: number;
	/** Decimal places for floats (fixed notation). Floats only — checked. */
	precision?: number;
	/** Integer base: `x`/`X` hex (lower/upper), `b` binary, `o` octal.
	 *  Integers only — checked. */
	base?: "x" | "X" | "b" | "o";
	/** The raw spec text (without the leading `:`), for error messages. */
	text: string;
	/** Source offset of the `:` — error positions point here. */
	start: number;
}
