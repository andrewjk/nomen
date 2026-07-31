import * as vscode from "vscode";

import parse from "../../src/parse.ts";
import type CompileError from "../../src/types/CompileError.ts";
import { analyze } from "./analysis.ts";
import type { Analysis } from "./analysis.ts";
import { load_library } from "./library.ts";
import { build_source_map } from "./source_map.ts";
import type { SourceMap } from "./source_map.ts";

export interface DocumentAnalysis {
	document: vscode.TextDocument;
	uri: vscode.Uri;
	version: number;
	map: SourceMap;
	analysis: Analysis;
	errors: CompileError[];
	/** Set when parsing threw outright, rather than reporting errors. */
	fatal?: string;
}

const cache = new Map<string, DocumentAnalysis>();
// The last analysis of each document that had no errors in the document
// itself, kept so completion still works while the source is mid-edit.
const clean_cache = new Map<string, Analysis>();

/**
 * Parse and index `document`, reusing the result until the document changes.
 * Every language feature (diagnostics included) shares this one parse.
 */
export function get_analysis(document: vscode.TextDocument): DocumentAnalysis | undefined {
	const key = document.uri.toString();
	const cached = cache.get(key);
	if (cached && cached.version === document.version) return cached;

	const library = load_library(document.uri);
	const map = build_source_map(document.uri.fsPath, document.getText(), library);

	let errors: CompileError[] = [];
	let analysis: Analysis = { defs: [], refs: [], types: new Map() };
	let fatal: string | undefined;
	try {
		const parsed = parse(map.source.slice(0, map.user_end), library, document.uri.fsPath);
		errors = parsed.errors;
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
		fatal,
	};
	cache.set(key, state);
	if (!fatal && !errors.some((e) => e.start >= 0 && e.start < map.doc_end)) {
		clean_cache.set(key, analysis);
	}
	return state;
}

/** The most recent error-free analysis of `document`, if there was one. */
export function get_fallback_analysis(document: vscode.TextDocument): Analysis | undefined {
	return clean_cache.get(document.uri.toString());
}

export function forget_document(uri: vscode.Uri): void {
	cache.delete(uri.toString());
	clean_cache.delete(uri.toString());
}
