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
	let content: string;
	try {
		content = fs.readFileSync(full, "utf8");
	} catch {
		add_error(status, `#embed_file could not read '${rel_path}' (resolved '${full}')`, start);
		return new ValueNode(start, '""');
	}
	return new ValueNode(start, `"${escape_embedded(content)}"`);
}

/** Encode file contents as a source-level string literal body. */
function escape_embedded(content: string): string {
	let out = "";
	for (const ch of content) {
		const code = ch.charCodeAt(0);
		if (ch === "\\") out += "\\\\";
		else if (ch === '"') out += '\\"';
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "\t") out += "\\t";
		else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, "0")}`;
		else out += ch;
	}
	return out;
}
