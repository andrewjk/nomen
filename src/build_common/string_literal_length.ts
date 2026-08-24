/**
 * The runtime byte length of a Nomen string literal token (the raw value
 * INCLUDING its surrounding quotes, as carried by ValueNode).
 *
 * The tokenizer keeps literals raw: source escape sequences (`\n`, `\t`,
 * `\\`, `\"`, …) stay as backslash + char, and the C backend splices the
 * text into a C string literal where clang decodes the same escapes at
 * runtime. The fat string's `len` must therefore be the UNESCAPED length:
 * every `\X` pair counts as one byte; every raw character (including raw
 * newlines inside multi-line literals) counts as one.
 */
export default function string_literal_length(raw: string): number {
	let len = 0;
	let i = 1; // skip the opening quote
	const end = raw.endsWith('"') ? raw.length - 1 : raw.length;
	while (i < end) {
		if (raw[i] === "\\") {
			if (raw[i + 1] === "x") {
				// `\xNN` hex escape — one decoded byte; consume the hex digits.
				i += 2;
				while (i < end && /[0-9a-fA-F]/.test(raw[i])) {
					i += 1;
				}
			} else {
				// An escape pair is one byte. `\u{...}`-style escapes would need
				// UTF-8 width math; Nomen's other escapes are single-byte.
				i += 2;
			}
		} else {
			i += 1;
		}
		len += 1;
	}
	return len;
}
