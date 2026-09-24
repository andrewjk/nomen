/**
 * Compile-time lint for Regex pattern literals (FOLLOWUP "Regex pattern
 * escapes").
 *
 * The Regex engine (core/System/Text/Regex.nm) recognizes only the
 * shorthands (`\d \D \w \W \s \S`), backreferences (`\1`-`\9`), the control
 * escapes (`\n \r \t`), and escaped metacharacters. Any OTHER engine escape
 — most notably a typo like `\z` — silently matches a literal letter. When a
 * Regex entry point's pattern argument is a static string literal, the check
 * can flag those as probable typos; dynamic runtime patterns can't be
 * validated this way.
 *
 * The literal arrives RAW (quotes included, Nomen escapes unresolved), so it
 * must first be decoded to the engine-visible bytes: a Nomen `"\n"` is a real
 * LF byte the engine treats as a literal, while `"\n"` reaches the engine as
 * a backslash + 'n' escape. Only the second spelling can carry a typo.
 */

/** Decode a raw string-literal token (quotes included) to its engine-visible
 * bytes, resolving Nomen's own string escapes. Mirrors the pair-counting of
 * string_literal_length and the decode rules of decode_char_literal. */
function decode_string_literal_bytes(raw: string): number[] {
	const bytes: number[] = [];
	let i = 1; // skip the opening quote
	const end = raw.endsWith('"') ? raw.length - 1 : raw.length;
	while (i < end) {
		if (raw[i] !== "\\") {
			// Raw source character: its UTF-8 encoding. Astral characters
			// arrive as UTF-16 surrogate pairs — consume both.
			const cp = raw.codePointAt(i) ?? 0;
			if (cp < 0x80) {
				bytes.push(cp);
				i += 1;
			} else if (cp < 0x800) {
				bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
				i += 1;
			} else if (cp < 0x10000) {
				bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
				i += 1;
			} else {
				bytes.push(
					0xf0 | (cp >> 18),
					0x80 | ((cp >> 12) & 0x3f),
					0x80 | ((cp >> 6) & 0x3f),
					0x80 | (cp & 0x3f),
				);
				i += 2;
			}
			continue;
		}
		const next = raw[i + 1];
		if (next === undefined) break;
		if (next === "x") {
			let j = i + 2;
			let value = 0;
			let digits = 0;
			while (j < end && digits < 2 && is_hex_digit(raw[j])) {
				value = value * 16 + hex_value(raw[j]);
				j += 1;
				digits += 1;
			}
			if (digits > 0) {
				bytes.push(value & 0xff);
				i = j;
				continue;
			}
			// Degenerate bare `\x` is rejected at check time elsewhere.
			i += 2;
			continue;
		}
		if (next >= "0" && next <= "7") {
			let j = i + 1;
			let value = 0;
			let digits = 0;
			while (j < end && digits < 3 && raw[j] >= "0" && raw[j] <= "7") {
				value = value * 8 + (raw[j].charCodeAt(0) - 48);
				j += 1;
				digits += 1;
			}
			bytes.push(value & 0xff);
			i = j;
			continue;
		}
		switch (next) {
			case "\\":
				bytes.push(92);
				break;
			case "n":
				bytes.push(10);
				break;
			case "t":
				bytes.push(9);
				break;
			case "r":
				bytes.push(13);
				break;
			case "0":
				bytes.push(0);
				break;
			case '"':
				bytes.push(34);
				break;
			case "'":
				bytes.push(39);
				break;
			default:
				// Unknown escapes decode leniently to the escaped character
				// itself (matching decode_char_literal).
				bytes.push(next.charCodeAt(0));
		}
		i += 2;
	}
	return bytes;
}

function is_hex_digit(c: string): boolean {
	return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

function hex_value(c: string): number {
	if (c <= "9") return c.charCodeAt(0) - 48;
	if (c <= "F") return c.charCodeAt(0) - 55;
	return c.charCodeAt(0) - 87;
}

function is_ascii_letter(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** Scan the decoded pattern bytes for escapes outside the engine's known set
 * (`\d \D \w \W \s \S`, `\1`-`\9`, `\n \r \t`, escaped punctuation) and
 * return one warning message per probable typo. */
export default function lint_regex_pattern(raw: string): string[] {
	const bytes = decode_string_literal_bytes(raw);
	const messages: string[] = [];
	let i = 0;
	while (i < bytes.length) {
		if (bytes[i] !== 92) {
			i += 1;
			continue;
		}
		const escaped = bytes[i + 1];
		if (escaped === undefined) break;
		const known =
			escaped === 100 ||
			escaped === 68 || // \d \D
			escaped === 119 ||
			escaped === 87 || // \w \W
			escaped === 115 ||
			escaped === 83 || // \s \S
			escaped === 110 ||
			escaped === 114 ||
			escaped === 116 || // \n \r \t
			(escaped >= 49 && escaped <= 57); // \1-\9 backreferences
		if (!known && is_ascii_letter(escaped)) {
			const letter = String.fromCharCode(escaped);
			messages.push(
				`Regex pattern: unsupported escape '\\${letter}' matches a literal '${letter}' — ` +
					`supported escapes are \\d \\D \\w \\W \\s \\S \\1-\\9 \\n \\r \\t and escaped punctuation`,
			);
		}
		i += 2;
	}
	return messages;
}
