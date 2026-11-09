/**
 * A compile-time format spec on a string interpolation argument:
 * `\{expr:spec}`. Parsed by the tokenizer/parse layer (which splits the raw
 * text after the expression's top-level `:`), validated against the
 * expression's type during checking, and lowered to a System `Format.*` call
 * that renders the argument before the interpolation helper sees it.
 *
 * Grammar (after the `:`, all parts optional, at most one of each):
 *
 *   spec      := fill? width? precision? mode?
 *   fill      := '<' (left-align) | '>' (right-align) | '0' (zero-pad)
 *   width     := digit+
 *   precision := '.' digit+
 *   mode      := 'x' | 'X' | 'b' | 'o' | 'n' | 'e' | 'E'
 *
 * - `<` / `>` pad the rendering with spaces to `width`; `0` zero-pads
 *   (integers/floats only, right-align only).
 * - `.N` renders a float with N decimal places (fixed notation).
 * - `x` / `X` render an integer as hexadecimal (lower/upper), `b` binary,
 *   `o` octal — integers only.
 * - `n` (or `N`) renders with thousands separators — integers and floats,
 *   composes with `.N` (the C# "N" standard format). Zero-padding does not
 *   combine with grouping.
 * - `e` / `E` render a float in exponential notation — floats only.
 *
 * A spec containing `#` or `,` is instead a custom pattern (the C#-style
 * mini-language): `0`/`#` placeholders, `.` decimals (trailing `#` slots
 * trim zeros), `,` groups (the rightmost comma sets the size), `%` (value
 * scaled ×100, `%` emitted at its position), `'...'` quoted literals, any
 * other character passes through, and at most two `;`-separated sections
 * (positive;negative — the negative section renders the absolute value).
 * Patterns are validated at compile time; alignment may compose via a
 * `<N`/`>N` prefix.
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
	/** Rendering mode letter: `x`/`X`/`b`/`o` integer bases, `n`/`N`
	 *  thousands grouping (integers and floats), `e`/`E` exponential
	 *  (floats only). Type rules are checked. */
	base?: "x" | "X" | "b" | "o" | "n" | "N" | "e" | "E";
	/** A custom numeric pattern (the C#-style mini-language). Present
	 *  instead of `precision`/`base` when the spec contains `#` or `,`;
	 *  alignment may still compose via `align`/`width`. */
	pattern?: string;
	/** The raw spec text (without the leading `:`), for error messages. */
	text: string;
	/** Source offset of the `:` — error positions point here. */
	start: number;
}
