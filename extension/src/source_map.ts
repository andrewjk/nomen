import fs from "node:fs";
import path from "node:path";

import { resolve_src_module, strip_main_functions } from "../../src/join.ts";
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
	for (const sibling of read_siblings(file_path, text, library)) {
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
// here would only duplicate declarations parse already inlines. Finally, the
// files named by the document's (and siblings') own project-relative imports
// (`import types::CharChange`, old-style `import types/CharChange`) are pulled
// in transitively, mirroring the compiler's module joiner — without this,
// types from subfolder modules have no definitions for hover/go-to-definition
// and silently-missing imports produce no diagnostics.
function read_siblings(
	file_path: string,
	doc_text: string,
	library: Library | undefined,
): SiblingSource[] {
	const self_dir = path.dirname(file_path);
	const self_base = path.basename(file_path);
	const seen = new Set<string>([file_path]);

	const siblings: SiblingSource[] = [];
	const pending: { dir: string; text: string }[] = [];
	const push_file = (dir: string, full: string, text: string) => {
		if (seen.has(full)) return;
		seen.add(full);
		siblings.push({ path: full, text });
		pending.push({ dir, text });
	};

	const add_siblings_in = (dir: string, exclude_base: string) => {
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
			push_file(dir, full, text);
		}
	};

	add_siblings_in(self_dir, self_base);

	const parent_dir = path.dirname(self_dir);
	const is_library_file = !!library?.dir && is_within(file_path, library.dir);
	if (parent_dir !== self_dir && !is_library_file) {
		add_siblings_in(parent_dir, "");
	}
	// A `*.test.nm` file can reference the program's `pub` declarations: pull
	// in the `src/` module (with `main` stripped, since the test harness
	// generates its own), mirroring how the compiler joins test sources.
	if (!is_library_file && self_base.endsWith(".test.nm")) {
		const src_dir = resolve_src_module(self_dir);
		if (src_dir) add_src_module(siblings, src_dir, seen);
	}

	// Follow project-relative imports transitively, starting from the
	// document's live text (which may be newer than disk). `System` imports
	// resolve through the library walker instead.
	pending.push({ dir: self_dir, text: doc_text });
	while (pending.length > 0) {
		const current = pending.shift()!;
		for (const target of project_imports(current.dir, current.text)) {
			const full = path.resolve(current.dir, target);
			if (seen.has(full)) continue;
			const text = read_file(full);
			if (text === undefined) continue;
			push_file(path.dirname(full), full, text);
		}
	}
	return siblings;
}

/**
 * Project-relative import targets in `text`, as `./`-rooted file paths.
 * Mirrors the compiler's module joiner: `import System` / `import System::…`
 * are library imports (skipped), anything else names a project file where
 * both `::` and `/` separate path segments (`import types::CharChange` and
 * the old `import types/CharChange` both mean `./types/CharChange.nm`).
 * Segments are trimmed (`Types:: Diff` from older formatter versions), and
 * a trailing segment naming a namespace directory (`import Types` for
 * `./Types/*.nm`) expands to every `.nm` file directly inside it.
 */
function project_imports(base_dir: string, text: string): string[] {
	const targets: string[] = [];
	const re = /^import(.*)$/gm;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const trimmed = match[1].trim();
		if (!trimmed || trimmed === "System" || trimmed.startsWith("System::")) continue;
		const rel = trimmed
			.split("::")
			.map((s) => s.trim())
			.filter((s) => s.length > 0)
			.join("/");
		if (!rel) continue;
		let is_dir = false;
		try {
			is_dir = fs.statSync(path.resolve(base_dir, rel)).isDirectory();
		} catch {
			// Not a directory — fall through to file resolution below.
		}
		if (is_dir) {
			let names: string[];
			try {
				names = fs.readdirSync(path.resolve(base_dir, rel));
			} catch {
				continue;
			}
			for (const name of names.sort()) {
				if (!name.endsWith(".nm")) continue;
				targets.push(`./${rel}/${name}`);
			}
			continue;
		}
		targets.push(`./${rel}.nm`);
	}
	return targets;
}

function add_src_module(out: SiblingSource[], src_dir: string, seen: Set<string>): void {
	let names: string[];
	try {
		names = fs.readdirSync(src_dir);
	} catch {
		return;
	}
	for (const name of names.sort()) {
		if (!name.endsWith(".nm")) continue;
		const full = path.join(src_dir, name);
		if (seen.has(full)) continue;
		const text = read_file(full);
		if (text === undefined) continue;
		seen.add(full);
		out.push({ path: full, text: strip_main_functions(text) });
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
