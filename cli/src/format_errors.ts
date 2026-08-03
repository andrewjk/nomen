import path from "node:path";

import type CompileError from "../../src/types/CompileError.ts";

interface FileMarker {
	abs_path: string;
	joined_line: number;
}

// Scan the joined source for `// file://<abs path>` headers inserted by join(),
// recording the 1-based joined-source line number each header sits on.
function find_file_markers(source: string): FileMarker[] {
	const markers: FileMarker[] = [];
	let line = 1;
	let i = 0;
	while (i < source.length) {
		const nl = source.indexOf("\n", i);
		const end = nl === -1 ? source.length : nl;
		const match = source.slice(i, end).match(/^\/\/ file:\/\/(.+)$/);
		if (match) markers.push({ abs_path: match[1], joined_line: line });
		if (nl === -1) break;
		line += 1;
		i = nl + 1;
	}
	return markers;
}

// Width of the token an error points at, so the caret can underline the whole
// identifier rather than a single column. Falls back to 1.
function token_width(line_text: string, start: number): number {
	let width = 0;
	while (start + width < line_text.length && /\w/.test(line_text[start + width])) {
		width += 1;
	}
	return width || 1;
}

const TAB_WIDTH = 4;

// Visual column (0-based) for a 1-based char column, expanding tabs.
function visual_start(line_text: string, col: number): number {
	let v = 0;
	for (let k = 0; k < col - 1 && k < line_text.length; k++) {
		v += line_text[k] === "\t" ? TAB_WIDTH : 1;
	}
	return v;
}

export default function render_errors(source: string, errors: CompileError[]): string {
	return render_messages(source, errors, "Error");
}

/** Render `messages` with a `Warning:`/`Error:` label and matching summary. */
export function render_warnings(source: string, warnings: CompileError[]): string {
	return render_messages(source, warnings, "Warning");
}

function render_messages(
	source: string,
	messages: CompileError[],
	severity: "Error" | "Warning",
): string {
	if (!messages.length) return "";
	const lines = source.split("\n");
	const markers = find_file_markers(source);

	const blocks: string[] = [];
	for (const message of messages) {
		const line_text = lines[message.line - 1] ?? "";

		// Map the joined-source line back to the originating file + in-file line.
		let rel_path = "";
		let file_line = message.line;
		for (let m = markers.length - 1; m >= 0; m--) {
			if (markers[m].joined_line < message.line) {
				file_line = message.line - markers[m].joined_line;
				rel_path = path.relative(process.cwd(), markers[m].abs_path) || markers[m].abs_path;
				break;
			}
		}

		const gutter = " ".repeat(String(file_line).length);
		const col = Math.max(1, message.column);
		const display_line = line_text.replace(/\t/g, " ".repeat(TAB_WIDTH));
		const squiggle = "~".repeat(token_width(line_text, col - 1));

		blocks.push(
			[
				`${severity}: ${message.message}`,
				` File: ${rel_path}:${file_line}:${col}`,
				`${gutter} |`,
				`${file_line} | ${display_line}`,
				`${gutter} | ${" ".repeat(visual_start(line_text, col))}${squiggle}`,
			].join("\n"),
		);
	}

	const label = messages.length === 1 ? severity.toLowerCase() : `${severity.toLowerCase()}s`;
	return `\n${blocks.join("\n\n")}\n\n${messages.length} ${label} found.\n`;
}
