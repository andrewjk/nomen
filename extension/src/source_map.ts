import fs from "node:fs";
import path from "node:path";

import type { Library } from "../../src/lib.ts";
import { resolve_linked_types } from "../../src/parse.ts";

/** A slice of the combined parse source that came from one file on disk. */
export interface SourceSegment {
	start: number;
	end: number;
	path: string;
}

export interface SourceMap {
	/** The full source handed to `parse` (document + siblings + library). */
	source: string;
	/** The document's own text, always at offset 0 of `source`. */
	doc_end: number;
	/** Everything the user wrote (document + sibling modules). */
	user_end: number;
	segments: SourceSegment[];
}

export interface FilePosition {
	path: string;
	line: number;
	character: number;
	end_line: number;
	end_character: number;
}

/**
 * Build the source that `parse` will see for `document`, along with a map from
 * offsets in that source back to the files they came from.
 *
 * The layout mirrors `parse`: the document's live text, then (for non-library
 * files) its sibling modules, then the library source resolved by
 * `resolve_linked_types`.
 */
export function build_source_map(
	file_path: string,
	text: string,
	library: Library | undefined,
): SourceMap {
	const segments: SourceSegment[] = [{ start: 0, end: text.length, path: file_path }];

	let user_source = text;
	const is_library_file = !!library?.dir && is_within(file_path, library.dir);
	if (!is_library_file) {
		for (const sibling of read_siblings(file_path)) {
			const start = user_source.length + 1;
			user_source += "\n" + sibling.text;
			segments.push({ start, end: start + sibling.text.length, path: sibling.path });
		}
	}

	let source = user_source;
	if (library) {
		source = resolve_linked_types(user_source, library, file_path);
		if (source.length > user_source.length) {
			add_library_segments(segments, source, user_source.length + 1, library);
		}
	}

	return { source, doc_end: text.length, user_end: user_source.length, segments };
}

/** Map a combined-source offset to the file and line/column it came from. */
export function map_offset(
	map: SourceMap,
	start: number,
	length: number,
): FilePosition | undefined {
	const segment = map.segments.find((s) => start >= s.start && start < s.end);
	if (!segment) return undefined;
	const text = read_file(segment.path);
	if (text === undefined) return undefined;
	const offset = start - segment.start;
	if (offset > text.length) return undefined;
	const position = position_at(text, offset);
	const end = position_at(text, Math.min(offset + length, text.length));
	return {
		path: segment.path,
		line: position.line,
		character: position.character,
		end_line: end.line,
		end_character: end.character,
	};
}

export function position_at(text: string, offset: number): { line: number; character: number } {
	let line = 0;
	let line_start = 0;
	for (let i = 0; i < offset; i++) {
		if (text[i] === "\n") {
			line += 1;
			line_start = i + 1;
		}
	}
	return { line, character: offset - line_start };
}

export function is_within(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// The library portion is the unique library file sources joined with "\n" (see
// `resolve_types_with_deps`), so walking it and matching each file's source in
// turn recovers the file each declaration came from.
function add_library_segments(
	segments: SourceSegment[],
	source: string,
	base: number,
	library: Library,
): void {
	const files = new Map<string, string>();
	for (const type of library.types.values()) {
		if (type.source.length && !files.has(type.source)) files.set(type.source, type.path);
	}
	const ordered = [...files].sort((a, b) => b[0].length - a[0].length);

	let pos = base;
	while (pos < source.length) {
		const match = ordered.find(([text]) => source.startsWith(text, pos));
		if (!match) break;
		segments.push({ start: pos, end: pos + match[0].length, path: match[1] });
		pos += match[0].length + 1;
	}
}

interface SiblingSource {
	path: string;
	text: string;
}

// Every other `.nm` file in the same folder, in the order `parse` sees them.
function read_siblings(file_path: string): SiblingSource[] {
	const dir = path.dirname(file_path);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const self = path.basename(file_path);
	const siblings: SiblingSource[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".nm")) continue;
		if (name === self) continue;
		const full = path.join(dir, name);
		const text = read_file(full);
		if (text !== undefined) siblings.push({ path: full, text });
	}
	return siblings;
}

const file_cache = new Map<string, { mtime: number; text: string }>();

/** Read a file, re-reading only when its mtime changes. */
export function read_file(file_path: string): string | undefined {
	try {
		const mtime = fs.statSync(file_path).mtimeMs;
		const cached = file_cache.get(file_path);
		if (cached && cached.mtime === mtime) return cached.text;
		const text = fs.readFileSync(file_path, "utf8");
		file_cache.set(file_path, { mtime, text });
		return text;
	} catch {
		return undefined;
	}
}
