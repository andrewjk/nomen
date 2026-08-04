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
 * The layout mirrors `parse`: the document's live text, then its sibling
 * modules (and, for user code, the parent folder's modules too), then the
 * library source resolved by `resolve_linked_types`.
 */
export function build_source_map(
	file_path: string,
	text: string,
	library: Library | undefined,
): SourceMap {
	const segments: SourceSegment[] = [{ start: 0, end: text.length, path: file_path }];

	let user_source = text;
	for (const sibling of read_siblings(file_path, library)) {
		const start = user_source.length + 1;
		user_source += "\n" + sibling.text;
		segments.push({ start, end: start + sibling.text.length, path: sibling.path });
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

// Every other `.nm` file in the same folder, so editor features see the same
// declarations the compiler sees when it concatenates a folder. For user code
// (files outside the resolved library), the parent folder's `.nm` files are
// pulled in too — library files resolve their parent folder through the
// library dependency walker (`resolve_linked_types`) instead, so reading them
// here would only duplicate declarations parse already inlines.
function read_siblings(file_path: string, library: Library | undefined): SiblingSource[] {
	const self_dir = path.dirname(file_path);
	const self_base = path.basename(file_path);
	const seen = new Set<string>([file_path]);

	const siblings: SiblingSource[] = [];
	add_dir(siblings, self_dir, self_base, seen);

	const parent_dir = path.dirname(self_dir);
	const is_library_file = !!library?.dir && is_within(file_path, library.dir);
	if (parent_dir !== self_dir && !is_library_file) {
		add_dir(siblings, parent_dir, "", seen);
	}
	return siblings;
}

function add_dir(out: SiblingSource[], dir: string, exclude_base: string, seen: Set<string>): void {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names.sort()) {
		if (!name.endsWith(".nm")) continue;
		if (name === exclude_base) continue;
		const full = path.join(dir, name);
		if (seen.has(full)) continue;
		const text = read_file(full);
		if (text === undefined) continue;
		seen.add(full);
		out.push({ path: full, text });
	}
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
