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

	const file_path = uri_to_path(document.uri);
	const library = load_library(file_path);
	const map = build_source_map(file_path, document.getText(), library);

	let errors: CompileError[] = [];
	let warnings: CompileError[] = [];
	let analysis: Analysis = { defs: [], refs: [], types: new Map() };
	let fatal: string | undefined;
	try {
		const parsed = parse(map.source.slice(0, map.user_end), library, file_path);
		errors = parsed.errors;
		warnings = parsed.warnings;
		analysis = analyze(parsed.root, map.source);
	} catch (err) {
		fatal = err instanceof Error ? err.message : String(err);
	}

	const state: DocumentAnalysis = {
		document,
		uri: document.uri,
		version: document.version,
		map,
		analysis,
		errors,
		warnings,
		fatal,
	};
	cache.set(key, state);
	if (!fatal && !errors.some((e) => e.start >= 0 && e.start < map.doc_end)) {
		clean_cache.set(key, analysis);
	}
	return state;
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
