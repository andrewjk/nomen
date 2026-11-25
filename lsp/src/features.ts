import { pathToFileURL } from "node:url";

import {
	CodeActionKind,
	CompletionItemKind,
	DiagnosticSeverity,
	InsertTextFormat,
	MarkupKind,
} from "vscode-languageserver";
import type {
	CodeAction,
	CodeLens,
	CompletionItem,
	Diagnostic,
	Hover,
	Location,
	Position,
	Range,
	TextEdit,
} from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";

import type QuickFix from "../../src/check/utils/QuickFix.ts";
import { format_source } from "../../src/format.ts";
import {
	all_members,
	def_at,
	lookup_at,
	ref_at,
	refs_to,
	resolve_chain,
	symbol_at,
} from "./analysis.ts";
import type { Analysis, Def, TypeInfo } from "./analysis.ts";
import { load_format_options } from "./config.ts";
import { get_analysis, get_fallback_analysis, uri_to_path } from "./documents.ts";
import type { DocumentAnalysis } from "./documents.ts";
import { map_offset } from "./source_map.ts";

// `self.items.` / `point.x` — the identifier chain the cursor is completing.
const CHAIN_BEFORE_CURSOR = /([A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*\.\s*$/;

// Matches `func main` at the start of a line, optionally preceded by `pub`.
const MAIN_FUNC = /^\s*(?:pub\s+)?func\s+main\b/;

const WORD_CHAR = /[A-Za-z0-9_]/;

// --- Diagnostics -------------------------------------------------------------

export function diagnostics_for(document: TextDocument): Diagnostic[] {
	const state = get_analysis(document);
	if (state.fatal) {
		return [
			{
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
				message: `Nomen: ${state.fatal}`,
				severity: DiagnosticSeverity.Error,
				source: "nomen",
			},
		];
	}

	const text = document.getText();
	const diags: Diagnostic[] = [];
	for (const e of state.errors) {
		if (e.start < 0 || e.start >= text.length) continue;
		diags.push({
			range: error_range(document, text, e.start),
			message: e.message,
			severity: DiagnosticSeverity.Error,
			source: "nomen",
		});
	}
	// Surface lint warnings (unused declarations, var-never-changed) as
	// warnings. Only those that fall within the document itself (not the
	// inlined library source).
	for (const w of state.warnings) {
		if (w.start < 0 || w.start >= text.length) continue;
		diags.push({
			range: error_range(document, text, w.start),
			message: w.message,
			severity: DiagnosticSeverity.Warning,
			source: "nomen",
		});
	}
	return diags;
}

function error_range(document: TextDocument, text: string, start: number): Range {
	let end = start;
	while (end < text.length && WORD_CHAR.test(text[end])) end++;
	if (end === start && start < text.length) end = start + 1;
	return { start: document.positionAt(start), end: document.positionAt(end) };
}

// --- Hover / definition / references ----------------------------------------

/** The range of the identifier under `position`, if any. */
function word_range_at(document: TextDocument, position: Position): Range | undefined {
	const text = document.getText();
	const offset = document.offsetAt(position);
	let start = offset;
	while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
	let end = offset;
	while (end < text.length && WORD_CHAR.test(text[end])) end++;
	if (start === end || !/[A-Za-z_]/.test(text[start])) return undefined;
	return { start: document.positionAt(start), end: document.positionAt(end) };
}

export function hover(document: TextDocument, position: Position): Hover | undefined {
	const range = word_range_at(document, position);
	if (!range) return undefined;
	const state = get_analysis(document);
	const def = symbol_at(state.analysis, document.offsetAt(range.start));
	if (!def) return undefined;

	let value = "```nomen\n" + def.signature + "\n```\n";
	if (def.container) value += `_${kind_label(def)} of \`${def.container}\`_\n\n`;
	if (def.doc) value += def.doc;
	return { contents: { kind: MarkupKind.Markdown, value }, range };
}

export function definition(document: TextDocument, position: Position): Location | undefined {
	const state = get_analysis(document);
	const offset = document.offsetAt(position);
	const def = ref_at(state.analysis, offset)?.def ?? def_at(state.analysis, offset);
	if (!def) return undefined;
	return to_location(state, def.start, def.length);
}

export function references(
	document: TextDocument,
	position: Position,
	include_declaration: boolean,
): Location[] {
	const state = get_analysis(document);
	const def = symbol_at(state.analysis, document.offsetAt(position));
	if (!def) return [];

	const locations: Location[] = [];
	if (include_declaration) {
		const declaration = to_location(state, def.start, def.length);
		if (declaration) locations.push(declaration);
	}
	for (const ref of refs_to(state.analysis, def)) {
		const location = to_location(state, ref.start, ref.length);
		if (location) locations.push(location);
	}
	return locations;
}

function to_location(state: DocumentAnalysis, start: number, length: number): Location | undefined {
	if (start < state.map.doc_end) {
		return {
			uri: state.uri,
			range: {
				start: state.document.positionAt(start),
				end: state.document.positionAt(start + length),
			},
		};
	}
	const position = map_offset(state.map, start, length);
	if (!position) return undefined;
	return {
		uri: pathToFileURL(position.path).href,
		range: {
			start: { line: position.line, character: position.character },
			end: { line: position.end_line, character: position.end_character },
		},
	};
}

// --- Completion --------------------------------------------------------------

export function completions(
	document: TextDocument,
	position: Position,
	snippets: boolean,
): CompletionItem[] {
	const line_start = document.offsetAt({ line: position.line, character: 0 });
	const offset = document.offsetAt(position);
	const line = document.getText().slice(line_start, offset);
	const match = line.match(CHAIN_BEFORE_CURSOR);
	if (!match) return [];
	const chain = match[1].split(".").map((part) => part.trim());

	// Typing `.` usually breaks the parse, so fall back to the last analysis
	// of this document that came out clean.
	const state = get_analysis(document);
	let resolved = resolve_chain(state.analysis, chain, offset);
	let analysis: Analysis | undefined = state.analysis;
	if (!resolved) {
		const fallback = get_fallback_analysis(document);
		if (fallback) {
			resolved = resolve_chain(fallback, chain, offset);
			analysis = fallback;
		}
	}
	if (!resolved || !analysis) return [];

	const inside = is_inside(analysis, resolved.info, offset) || chain[0] === "self";
	return members_of(analysis, resolved.info, resolved.is_static, inside, snippets);
}

function members_of(
	analysis: Analysis,
	info: TypeInfo,
	is_static: boolean,
	inside: boolean,
	snippets: boolean,
): CompletionItem[] {
	const items: CompletionItem[] = [];
	const seen = new Set<string>();
	for (const member of all_members(analysis.types, info)) {
		if (seen.has(member.name)) continue;
		if (member.name.startsWith("#")) continue;
		if (!inside && (member.visibility === "private" || member.visibility === "internal")) continue;
		if (member.kind === "method" && !!member.is_static !== is_static) continue;
		if (member.kind === "field" && is_static) continue;
		seen.add(member.name);

		const item: CompletionItem = {
			label: member.name,
			kind: completion_kind(member),
			detail: member.signature,
		};
		if (member.doc) item.documentation = { kind: MarkupKind.Markdown, value: member.doc };
		if (member.kind === "method" && snippets) {
			item.insertText = `${member.name}($0)`;
			item.insertTextFormat = InsertTextFormat.Snippet;
		}
		items.push(item);
	}
	return items;
}

// Is `offset` inside the type that owns these members? Private members are only
// offered there.
function is_inside(analysis: Analysis, info: TypeInfo, offset: number): boolean {
	const self = lookup_at(analysis, "self", offset);
	return self?.type?.name === info.name;
}

function completion_kind(def: Def): CompletionItemKind {
	switch (def.kind) {
		case "method":
			return CompletionItemKind.Method;
		case "field":
			return CompletionItemKind.Field;
		case "case":
			return CompletionItemKind.EnumMember;
		default:
			return CompletionItemKind.Property;
	}
}

function kind_label(def: Def): string {
	switch (def.kind) {
		case "method":
			return "method";
		case "field":
			return "field";
		case "case":
			return "case";
		case "param":
			return "parameter";
		default:
			return def.kind;
	}
}

// --- Formatting --------------------------------------------------------------

/** Compute the edits that format `document`. When `force`, bypass the
 *  token-safety check so an explicit "force format" applies the layout anyway. */
export function format_edits(document: TextDocument, force: boolean): TextEdit[] {
	const source = document.getText();
	const options = load_format_options(uri_to_path(document.uri));
	const result = format_source(source, options, force);
	if (!result.changed) return [];
	const range = { start: document.positionAt(0), end: document.positionAt(source.length) };
	return [{ range, newText: result.code }];
}

// --- Code actions ------------------------------------------------------------

/**
 * Quick fixes for declared field effects (docs/FIELD_EFFECTS.md): the
 * checker attaches a structured edit (`CompileError.quick_fix`) to
 * declared-effect diagnostics — an un-annotated `ref` parameter whose body
 * mutates a heap field (a warning), or a clause violation (an error). This
 * applies the edit: insert the `mutates { … }` clause, or extend / replace
 * the declared set.
 */
export function code_actions(document: TextDocument, diagnostics: Diagnostic[]): CodeAction[] {
	const state = get_analysis(document);
	const actions: CodeAction[] = [];
	for (const diagnostic of diagnostics) {
		const fix = matching_quick_fix(state, document, diagnostic);
		if (!fix) continue;
		const edit = quick_fix_edit(document, fix);
		if (!edit) continue;
		actions.push({
			title: fix.title,
			kind: CodeActionKind.QuickFix,
			diagnostics: [diagnostic],
			isPreferred: true,
			edit: { changes: { [document.uri]: [edit] } },
		});
	}
	return actions;
}

/** The compiler diagnostic a client diagnostic came from — matched by message
 *  and start offset (both derive from the same CompileError). */
function matching_quick_fix(
	state: DocumentAnalysis,
	document: TextDocument,
	diagnostic: Diagnostic,
): QuickFix | undefined {
	const offset = document.offsetAt(diagnostic.range.start);
	for (const error of [...state.errors, ...state.warnings]) {
		if (error.start !== offset || error.message !== diagnostic.message) continue;
		if (error.quick_fix) return error.quick_fix;
	}
	return undefined;
}

function quick_fix_edit(document: TextDocument, fix: QuickFix): TextEdit | undefined {
	if (fix.insert_offset !== undefined && fix.insert_text !== undefined) {
		const at = document.positionAt(fix.insert_offset);
		return { range: { start: at, end: at }, newText: fix.insert_text };
	}
	if (
		fix.replace_start !== undefined &&
		fix.replace_end !== undefined &&
		fix.replace_text !== undefined
	) {
		return {
			range: {
				start: document.positionAt(fix.replace_start),
				end: document.positionAt(fix.replace_end),
			},
			newText: fix.replace_text,
		};
	}
	return undefined;
}

// --- Code lenses -------------------------------------------------------------

/** Run / Audit lenses above `func main`. The commands (`nomen.run`,
 *  `nomen.audit`) are client-side, so these are only sent to clients that
 *  said they implement them (`initializationOptions.runCommands`). */
export function code_lenses(document: TextDocument): CodeLens[] {
	const lenses: CodeLens[] = [];
	const lines = document.getText().split("\n");
	for (let i = 0; i < lines.length; i++) {
		const text = lines[i].replace(/\r$/, "");
		if (!MAIN_FUNC.test(text)) continue;
		const range = { start: { line: i, character: 0 }, end: { line: i, character: text.length } };
		lenses.push(
			{ range, command: { title: "Run", command: "nomen.run", arguments: [document.uri] } },
			{ range, command: { title: "Audit", command: "nomen.audit", arguments: [document.uri] } },
		);
	}
	return lenses;
}
