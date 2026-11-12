import fs from "node:fs";
import path from "node:path";

import add_error from "../../add_error.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type ParseStatus from "../ParseStatus.ts";
import consume from "./consume.ts";
import expect from "./expect.ts";
import get_index from "./get_index.ts";

/**
 * `#embed_file("relative/path")` — a compile-time string literal whose value
 * is the contents of the file at parse time. The path resolves against the
 * package root (the directory containing package.jsonc, found by climbing
 * from the entry file), falling back to the entry file's folder; with no
 * known base it resolves against the process CWD.
 *
 * The parsed form is a plain string-literal ValueNode: escapes are encoded
 * with the source-level escape set (`\\`, `\"`, `\n`, `\r`, `\t`, and
 * three-digit octal for other control bytes — self-terminating, matching the
 * escape scanner), so every downstream consumer (length counting, C/asm
 * emission) treats it exactly like a hand-written literal.
 */
export default function parse_embed_file(status: ParseStatus): ValueNode {
	const start = get_index(status);
	consume(status); // `#`
	const name = consume(status);
	if (name !== "embed_file") {
		add_error(status, `Unknown compiler directive '#${name}' — did you mean '#embed_file'?`, start);
		return new ValueNode(start, '""');
	}
	if (!expect("(", status)) {
		return new ValueNode(start, '""');
	}
	const path_token = status.tokens[status.i];
	if (!path_token || !path_token.value.startsWith('"')) {
		add_error(status, "Expected a string literal path in #embed_file", start);
		return new ValueNode(start, '""');
	}
	status.i += 1;
	const rel_path = path_token.value.slice(1, -1);
	if (!expect(")", status)) {
		return new ValueNode(start, '""');
	}

	if (!rel_path) {
		add_error(status, "#embed_file path is empty", start);
		return new ValueNode(start, '""');
	}
	const base = status.embed_root ?? process.cwd();
	const full = path.isAbsolute(rel_path) ? rel_path : path.join(base, rel_path);
	let content: Buffer;
	try {
		// Binary-safe: PNGs, fonts, any bytes. Byte-transparent escaping
		// (below) round-trips every value; text files decode identically.
		content = fs.readFileSync(full);
	} catch (cause) {
		const idx = status.tokens.findIndex((t) => t.value === "#embed_file" && t.i === start);
		const near = status.tokens.slice(Math.max(0, idx - 2), idx + 4).map((t) => t.value);
		console.log(
			`[embed-debug] tokens near: ${JSON.stringify(near)} embed_root=${JSON.stringify(status.embed_root)}`,
		);
		add_error(status, `#embed_file could not read '${rel_path}' (resolved '${full}')`, start);
		return new ValueNode(start, '""');
	}
	return new ValueNode(start, `"${escape_embedded_bytes(content)}"`);
}

/** Encode file contents as a source-level string literal body —
 *  byte-transparent: printable ASCII passes through, everything else
 *  (control bytes, quotes, backslashes, and every byte ≥ 0x7F) becomes a
 *  three-digit octal escape, which the escape scanner decodes back to the
 *  same byte. Self-terminating in C string literals too (the decoder
 *  consumes exactly three octal digits). */
export function escape_embedded_bytes(content: Buffer): string {
	let out = "";
	for (const byte of content) {
		if (byte === 0x5c) out += "\\\\";
		else if (byte === 0x22) out += '\\"';
		else if (byte === 0x0a) out += "\\n";
		else if (byte === 0x0d) out += "\\r";
		else if (byte === 0x09) out += "\\t";
		else if (byte < 0x20 || byte >= 0x7f) out += `\\${byte.toString(8).padStart(3, "0")}`;
		else out += String.fromCharCode(byte);
	}
	return out;
}
