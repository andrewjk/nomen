import * as vscode from "vscode";

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
import { get_analysis, get_fallback_analysis } from "./documents.ts";
import type { DocumentAnalysis } from "./documents.ts";
import { map_offset } from "./source_map.ts";

// `self.items.` / `point.x` — the identifier chain the cursor is completing.
const CHAIN_BEFORE_CURSOR = /([A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*\.\s*$/;

export class NomenHoverProvider implements vscode.HoverProvider {
	provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		const state = get_analysis(document);
		if (!state) return undefined;
		const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
		if (!range) return undefined;

		const def = symbol_at(state.analysis, document.offsetAt(range.start));
		if (!def) return undefined;

		const md = new vscode.MarkdownString();
		md.appendCodeblock(def.signature, "nomen");
		if (def.container) md.appendMarkdown(`_${kind_label(def)} of \`${def.container}\`_\n\n`);
		if (def.doc) md.appendMarkdown(def.doc);
		return new vscode.Hover(md, range);
	}
}

export class NomenDefinitionProvider implements vscode.DefinitionProvider {
	provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.Location | undefined {
		const state = get_analysis(document);
		if (!state) return undefined;
		const offset = document.offsetAt(position);
		const def = ref_at(state.analysis, offset)?.def ?? def_at(state.analysis, offset);
		if (!def) return undefined;
		return to_location(state, def.start, def.length);
	}
}

export class NomenReferenceProvider implements vscode.ReferenceProvider {
	provideReferences(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.ReferenceContext,
	): vscode.Location[] | undefined {
		const state = get_analysis(document);
		if (!state) return undefined;
		const def = symbol_at(state.analysis, document.offsetAt(position));
		if (!def) return undefined;

		const locations: vscode.Location[] = [];
		if (context.includeDeclaration) {
			const declaration = to_location(state, def.start, def.length);
			if (declaration) locations.push(declaration);
		}
		for (const ref of refs_to(state.analysis, def)) {
			const location = to_location(state, ref.start, ref.length);
			if (location) locations.push(location);
		}
		return locations;
	}
}

export class NomenCompletionProvider implements vscode.CompletionItemProvider {
	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.CompletionItem[] | undefined {
		const line = document.lineAt(position.line).text.slice(0, position.character);
		const match = line.match(CHAIN_BEFORE_CURSOR);
		if (!match) return undefined;
		const chain = match[1].split(".").map((part) => part.trim());
		const offset = document.offsetAt(position);

		// Typing `.` usually breaks the parse, so fall back to the last analysis
		// of this document that came out clean.
		const state = get_analysis(document);
		let resolved = state ? resolve_chain(state.analysis, chain, offset) : undefined;
		let analysis: Analysis | undefined = state?.analysis;
		if (!resolved) {
			const fallback = get_fallback_analysis(document);
			if (fallback) {
				resolved = resolve_chain(fallback, chain, offset);
				analysis = fallback;
			}
		}
		if (!resolved || !analysis) return undefined;

		const inside = is_inside(analysis, resolved.info, offset) || chain[0] === "self";
		return members_of(analysis, resolved.info, resolved.is_static, inside);
	}
}

function members_of(
	analysis: Analysis,
	info: TypeInfo,
	is_static: boolean,
	inside: boolean,
): vscode.CompletionItem[] {
	const items: vscode.CompletionItem[] = [];
	const seen = new Set<string>();
	for (const member of all_members(analysis.types, info)) {
		if (seen.has(member.name)) continue;
		if (member.name.startsWith("#")) continue;
		if (!inside && member.visibility === "private") continue;
		if (member.kind === "method" && !!member.is_static !== is_static) continue;
		if (member.kind === "field" && is_static) continue;
		seen.add(member.name);

		const item = new vscode.CompletionItem(member.name, completion_kind(member));
		item.detail = member.signature;
		if (member.doc) item.documentation = new vscode.MarkdownString(member.doc);
		if (member.kind === "method") {
			item.insertText = new vscode.SnippetString(`${member.name}($0)`);
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

function completion_kind(def: Def): vscode.CompletionItemKind {
	switch (def.kind) {
		case "method":
			return vscode.CompletionItemKind.Method;
		case "field":
			return vscode.CompletionItemKind.Field;
		case "case":
			return vscode.CompletionItemKind.EnumMember;
		default:
			return vscode.CompletionItemKind.Property;
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

function to_location(
	state: DocumentAnalysis,
	start: number,
	length: number,
): vscode.Location | undefined {
	if (start < state.map.doc_end) {
		return new vscode.Location(
			state.uri,
			new vscode.Range(state.document.positionAt(start), state.document.positionAt(start + length)),
		);
	}
	const position = map_offset(state.map, start, length);
	if (!position) return undefined;
	return new vscode.Location(
		vscode.Uri.file(position.path),
		new vscode.Range(position.line, position.character, position.end_line, position.end_character),
	);
}

export class NomenDocumentFormattingProvider implements vscode.DocumentFormattingEditProvider {
	provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
		const source = document.getText();
		const options = load_format_options(document.uri.fsPath);
		const result = format_source(source, options);
		if (!result.changed) return [];
		const full_range = new vscode.Range(document.positionAt(0), document.positionAt(source.length));
		return [vscode.TextEdit.replace(full_range, result.code)];
	}
}
