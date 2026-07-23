// Integer literal helpers shared across parse, check, and build passes.
//
// Nomen integer literals may be written in four bases:
//
//   decimal   255        1_000
//   hex       0xFF       0xCAFE_F00D
//   octal     0o377      0o6_44
//   binary    0b11111111 0b1010_1010
//
// Underscores are digit separators and are ignored. Decimal literals may
// carry a leading `+`/`-` sign (the tokenizer folds the sign into the token);
// hex/octal/binary literals are always non-negative — negate with `0 - x`.

const RE = /^[+-]?(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|[0-9][0-9_]*)$/;

export function is_int_literal(value: string): boolean {
	return RE.test(value);
}

// Parse an integer literal (any base, optional sign) to a JS number. Returns
// NaN if the value is not an integer literal. Note: values beyond 2^53 lose
// precision in JS's double — use parse_int_literal_bigint for exact 64-bit
// range checks.
export function parse_int_literal(value: string): number {
	if (!is_int_literal(value)) return NaN;
	const s = value.replace(/_/g, "");
	const sign = s.startsWith("-") ? -1 : 1;
	const body = s.startsWith("-") || s.startsWith("+") ? s.substring(1) : s;
	let n: number;
	if (body[1] === "x" || body[1] === "X") n = parseInt(body.substring(2), 16);
	else if (body[1] === "o" || body[1] === "O") n = parseInt(body.substring(2), 8);
	else if (body[1] === "b" || body[1] === "B") n = parseInt(body.substring(2), 2);
	else n = parseInt(body, 10);
	return sign * n;
}

// Parse an integer literal (any base, optional sign) to an exact BigInt. Use
// this for range checks where full 64-bit precision matters (e.g. verifying
// 0xFFFFFFFFFFFFFFFF fits in uint64). Returns null if not an integer literal.
export function parse_int_literal_bigint(value: string): bigint | null {
	if (!is_int_literal(value)) return null;
	const s = value.replace(/_/g, "");
	const negative = s.startsWith("-");
	const body = negative || s.startsWith("+") ? s.substring(1) : s;
	let n: bigint;
	if (body[1] === "x" || body[1] === "X") n = BigInt("0x" + body.substring(2));
	else if (body[1] === "o" || body[1] === "O") n = BigInt("0o" + body.substring(2));
	else if (body[1] === "b" || body[1] === "B") n = BigInt("0b" + body.substring(2));
	else n = BigInt(body);
	return negative ? -n : n;
}

// Convert an integer literal (any base, optional sign) to its decimal string
// representation with full precision (BigInt), so large 64-bit constants like
// 0xFFFFFFFFFFFFFFFF aren't rounded by JS's double. Used by the aarch64
// backend, whose assembler needs decimal operands. Non-integer-literal inputs
// (floats, bools) are returned unchanged.
export function to_decimal_string(value: string): string {
	const n = parse_int_literal_bigint(value);
	return n === null ? value : n.toString();
}
