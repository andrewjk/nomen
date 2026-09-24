/**
 * Source string-literal escape handling shared by both backends.
 *
 * The tokenizer keeps literals raw (escape sequences stay as backslash +
 * char, `string_literal_length` decodes them for the fat len). The emitters
 * splice that raw text into C string literals / GAS `.asciz` directives —
 * and BOTH clang and GAS parse `\x` hex escapes GREEDILY (all following hex
 * digits are consumed), so a source `"\x01AMP"` reaches C as `"\x01AMP"`
 * where `\x01A` parses as ONE byte 0x1A and a longer run exceeds the byte
 * range entirely (clang: "hex escape sequence out of range"). The fix is to
 * re-encode every `\x` escape as a THREE-digit octal escape: octal is
 * capped at 3 digits in both C and GAS, so the encoding is
 * self-terminating — a following `0`-`7` character in the text can never
 * glue onto it.
 *
 * Degenerate escapes (`\8`, `\9`, `\x` with no digits, out-of-byte-range
 * hex/octal runs, `\u`/`\U`) are REJECTED at check time (see
 * scan_string_escapes) — the old behavior silently diverged between the
 * length counter's pair-counting and what clang/GAS actually decode.
 */

/** Re-encode `\xHH` hex escapes as 3-digit octal. All other escapes and
 *  raw bytes pass through untouched (raw control characters are the
 *  caller's business — see escape_c_string / escape_asciz). */
export default function reencode_hex_escapes(raw: string): string {
	if (!raw.includes("\\x")) return raw;
	let out = "";
	let i = 0;
	while (i < raw.length) {
		const c = raw[i];
		if (c === "\\" && raw[i + 1] === "x") {
			let j = i + 2;
			let value = 0;
			let digits = 0;
			while (j < raw.length && digits < 2 && is_hex_digit(raw[j])) {
				value = value * 16 + hex_value(raw[j]);
				j += 1;
				digits += 1;
			}
			if (digits > 0) {
				out += `\\${value.toString(8).padStart(3, "0")}`;
				i = j;
				continue;
			}
			// Degenerate bare `\x`: rejected at check time; kept verbatim so
			// the emitter never invents bytes for an invalid program.
		}
		out += c;
		i += 1;
	}
	return out;
}

export function is_hex_digit(c: string): boolean {
	return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

function hex_value(c: string): number {
	if (c <= "9") return c.charCodeAt(0) - 48;
	if (c <= "F") return c.charCodeAt(0) - 55;
	return c.charCodeAt(0) - 87;
}

/**
 * Check-time validation of one raw string-literal token (quotes included).
 * Returns one human-readable message per degenerate escape:
 * - `\8` / `\9` — clang decodes these as the literal digit (with a warning)
 *   while the length counter pair-counts them as one byte;
 * - `\x` with no hex digit — clang rejects, GAS decodes 0;
 * - `\x` with more than 2 hex digits — cannot be one byte (the length
 *   counter says 1 byte, clang errors with "out of range");
 * - octal runs whose value exceeds one byte (clang errors the same way);
 * - `\u` / `\U` — universal-character-name escapes encode as UTF-8 (2+
 *   bytes) or reject, never the one byte the length counter assumes.
 */
export function scan_string_escapes(raw: string): string[] {
	const issues: string[] = [];
	let i = 1; // skip the opening quote
	const end = raw.endsWith('"') ? raw.length - 1 : raw.length;
	while (i < end) {
		if (raw[i] !== "\\") {
			i += 1;
			continue;
		}
		const next = raw[i + 1];
		if (next === "x") {
			let j = i + 2;
			let digits = 0;
			while (j < end && digits < 2 && is_hex_digit(raw[j])) {
				j += 1;
				digits += 1;
			}
			if (digits === 0) {
				issues.push("incomplete hex escape '\\x' — expected 1 or 2 hex digits");
			}
			// Hex runs are CAPPED at 2 digits by definition (matching the
			// length counter and the emitters' octal re-encode): a following
			// hex digit is ordinary text, `"\x01AMP"` is byte 0x01 + "AMP".
			i = j;
			continue;
		}
		if (next === "u" || next === "U") {
			issues.push(`unsupported escape '\\${next}' — universal character names are not supported`);
			i += 2;
			continue;
		}
		if (next >= "0" && next <= "7") {
			let j = i + 1;
			let digits = 0;
			let value = 0;
			while (j < end && digits < 3 && raw[j] >= "0" && raw[j] <= "7") {
				value = value * 8 + (raw[j].charCodeAt(0) - 48);
				j += 1;
				digits += 1;
			}
			if (value > 0xff) {
				issues.push(`octal escape '${raw.substring(i, j)}' does not fit in one byte`);
			}
			i = j;
			continue;
		}
		if (next === "8" || next === "9") {
			issues.push(`unknown escape sequence '\\${next}'`);
			i += 2;
			continue;
		}
		i += 2;
	}
	return issues;
}

/** Escape one raw string-literal token (quotes included) for a GAS
 *  `.asciz` directive: source `\xHH` hex escapes re-encode as 3-digit octal
 *  (GAS consumes `\x` greedily — see reencode_hex_escapes) and raw newlines
 *  (multi-line strings) become `\n` so the directive stays one line. */
export function escape_asciz(value: string): string {
	const reencoded = reencode_hex_escapes(value);
	if (!reencoded.includes("\n")) return reencoded;
	const quote = reencoded[0];
	const content = reencoded.slice(1, reencoded.endsWith(quote) ? -1 : undefined);
	return quote + content.replace(/\n/g, "\\n") + (reencoded.endsWith(quote) ? quote : "");
}
