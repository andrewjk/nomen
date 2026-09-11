/**
 * Decode a Nomen char literal token (raw value INCLUDING its surrounding
 * quotes, as carried by ValueNode) to its numeric code. The tokenizer
 * consumes escape pairs as a unit, so multi-char forms like `'\\\\'`,
 * `'\\n'`, `'\\''` and `'\\xNN'` arrive raw and must be decoded here.
 * Returns undefined for malformed literals.
 */
export default function decode_char_literal(raw: string): number | undefined {
	if (raw.length < 3 || raw[0] !== "'" || raw[raw.length - 1] !== "'") {
		return undefined;
	}
	const inner = raw.slice(1, -1);
	if (inner.length === 1) {
		return inner.charCodeAt(0);
	}
	if (inner[0] !== "\\") {
		return undefined;
	}
	const esc = inner[1];
	switch (esc) {
		case "\\":
			return 92;
		case "n":
			return 10;
		case "t":
			return 9;
		case "r":
			return 13;
		case "'":
			return 39;
		case '"':
			return 34;
		case "0":
			return 0;
		case "x": {
			const hex = inner.slice(2);
			if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined;
			return parseInt(hex, 16);
		}
		default:
			// Unknown escapes keep the historic lenient behavior of yielding
			// the escaped character itself.
			return esc.charCodeAt(0);
	}
}
