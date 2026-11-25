import { fileURLToPath } from "node:url";

import type { TextDocument } from "vscode-languageserver-textdocument";

import parse from "../../src/parse.ts";
import type CompileError from "../../src/types/CompileError.ts";
import { analyze } from "./analysis.ts";
import type { Analysis } from "./analysis.ts";
import { load_library } from "./library.ts";
import { build_source_map } from "./source_map.ts";
import type { SourceMap } from "./source_map.ts";

export interface DocumentAnalysis {
	document: TextDocument;
	uri: string;
	version: number;
	map: SourceMap;
	analysis: Analysis;
	errors: CompileError[];
	warnings: CompileError[];
	/** Set when parsing threw outright, rather than reporting errors. */
	fatal?: string;
}

const cache = new Map<string, DocumentAnalysis>();
// The last analysis of each document that had no errors in the document
// itself, kept so completion still works while the source is mid-edit.
const clean_cache = new Map<string, Analysis>();

/** The filesystem path of a `file:` URI (other schemes map to their path). */
export function uri_to_path(uri: string): string {
	if (uri.startsWith("file:")) return fileURLToPath(uri);
	return uri.replace(/^[a-z][a-z0-9+.-]*:/i, "");
}

/**
 * Parse and index `document`, reusing the result until the document changes.
 * Every language feature (diagnostics included) shares this one parse.
 */
export function get_analysis(document: TextDocument): DocumentAnalysis {
	const key = document.uri;
	const cached = cache.get(key);
	if (cached && cached.version === document.version) return cached;

	const state = analyze_text(document, document.getText());
	cache.set(key, state);
	if (!state.fatal && !state.errors.some((e) => e.start >= 0 && e.start < state.map.doc_end)) {
		clean_cache.set(key, state.analysis);
	}
	return state;
}

/**
 * Parse and index `text` as if it were `document`'s contents, without
 * caching — e.g. the document with a dangling `.` blanked out, so member
 * completion can resolve the receiver at unchanged offsets.
 */
export function analyze_text(document: TextDocument, text: string): DocumentAnalysis {
	const file_path = uri_to_path(document.uri);
	const library = load_library(file_path);
	const map = build_source_map(file_path, text, library);

	let errors: CompileError[] = [];
	let warnings: CompileError[] = [];
	let analysis: Analysis = { defs: [], refs: [], types: new Map() };
	let fatal: string | undefined;
	try {
		const parsed = parse(map.source.slice(0, map.user_end), library, file_path);
		errors = attribute_end_of_input(parsed.errors, map, text, file_path);
		warnings = parsed.warnings;
		analysis = analyze(parsed.root, map.source);
	} catch (err) {
		fatal = err instanceof Error ? err.message : String(err);
	}

	return {
		document,
		uri: document.uri,
		version: document.version,
		map,
		analysis,
		errors,
		warnings,
		fatal,
	};
}

/**
 * The parser reports an unterminated construct (`const q = 1 +`, a missing
 * `}`) as an error at the end of its input. Here that input is the COMBINED
 * source — document, sibling modules, inlined System library — so the error
 * lands past the document and would be dropped as belonging to another file.
 * Parse the document on its own to see whether the unterminated construct is
 * its own; if so, report the error on the document's last character instead.
 * (An end-of-input error the document alone doesn't reproduce comes from a
 * sibling module and stays out of this document's diagnostics.)
 */
function attribute_end_of_input(
	errors: CompileError[],
	map: SourceMap,
	text: string,
	file_path: string,
): CompileError[] {
	const input_end = map.source.trimEnd().length;
	const doc_end = text.trimEnd().length;
	const at_end = (e: CompileError, end: number) => e.start >= end;
	if (!errors.some((e) => at_end(e, input_end)) || doc_end === 0) return errors;

	// Already the document's own end (no siblings or library appended).
	const own = map.source.length === text.length;
	let reproduced: CompileError | undefined;
	if (!own) {
		try {
			reproduced = parse(text, undefined, file_path).errors.find((e) => at_end(e, doc_end));
		} catch {
			// A throwing doc-only parse tells us nothing; leave errors as they are.
		}
		if (!reproduced) return errors;
	}

	const last = doc_end - 1;
	const out: CompileError[] = [];
	let placed = false;
	for (const e of errors) {
		if (!at_end(e, own ? doc_end : input_end)) {
			out.push(e);
			continue;
		}
		if (placed) continue;
		placed = true;
		out.push({ ...e, message: `${e.message} (reached end of file)`, start: last });
	}
	return out;
}

/** The most recent error-free analysis of `document`, if there was one. */
export function get_fallback_analysis(document: TextDocument): Analysis | undefined {
	return clean_cache.get(document.uri);
}

export function forget_document(uri: string): void {
	cache.delete(uri);
	clean_cache.delete(uri);
}

/** Drop every cached analysis so the next read recomputes. */
export function invalidate_all(): void {
	cache.clear();
	clean_cache.clear();
}
