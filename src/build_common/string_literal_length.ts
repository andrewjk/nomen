/**
 * The runtime byte length of a Nomen string literal token (the raw value
 * INCLUDING its surrounding quotes, as carried by ValueNode).
 *
 * The tokenizer keeps literals raw: source escape sequences (`\n`, `\t`,
 * `\\`, `\"`, …) stay as backslash + char, and the C backend splices the
 * text into a C string literal where clang decodes the same escapes at
 * runtime. The fat string's `len` must therefore be the UNESCAPED length:
 * every `\X` pair counts as one byte; every raw character counts its UTF-8
 * width (raw multibyte characters are spliced through as bytes by both
 * backends, so `"café"` is 5, not 4).
 */
export default function string_literal_length(raw: string): number {
	let len = 0;
	let i = 1; // skip the opening quote
	const end = raw.endsWith('"') ? raw.length - 1 : raw.length;
	while (i < end) {
		if (raw[i] === "\\") {
			if (raw[i + 1] === "x") {
				// `\xNN` hex escape — one decoded byte; consume AT MOST two
				// hex digits (clang and GAS would greedily eat the whole run,
				// so the emitters re-encode as self-terminating 3-digit octal
				// and the language defines the run as capped at 2 — a
				// following hex digit is ordinary text, `"\x01AMP"` is 4
				// bytes).
				i += 2;
				let digits = 0;
				while (i < end && digits < 2 && /[0-9a-fA-F]/.test(raw[i])) {
					i += 1;
					digits += 1;
				}
			} else if (raw[i + 1] >= "0" && raw[i + 1] <= "7") {
				// Octal escape — up to 3 digits, one byte. Both clang and
				// GAS parse octal natively, so the length must agree with
				// them (`"\0123"` is LF + "3", not NUL + "123").
				i += 2;
				let digits = 1;
				while (digits < 3 && i < end && raw[i] >= "0" && raw[i] <= "7") {
					i += 1;
					digits += 1;
				}
			} else {
				// An escape pair is one byte. `\u{...}`-style escapes would need
				// UTF-8 width math; Nomen's other escapes are single-byte.
				i += 2;
			}
			len += 1;
		} else {
			// Raw source character: its UTF-8 encoding width. Astral
			// characters arrive as UTF-16 surrogate pairs — consume both.
			const cp = raw.codePointAt(i) ?? 0;
			if (cp < 0x80) {
				len += 1;
			} else if (cp < 0x800) {
				len += 2;
			} else if (cp < 0x10000) {
				len += 3;
			} else {
				len += 4;
				i += 1;
			}
			i += 1;
		}
	}
	return len;
}
