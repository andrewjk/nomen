import fs from "node:fs";
import path from "node:path";

import { get_library, resolve_export_files, type Library } from "../../src/lib.ts";
import type BaseNode from "../../src/nodes/BaseNode.ts";
import type BitsetNode from "../../src/nodes/BitsetNode.ts";
import type DeclarationNode from "../../src/nodes/DeclarationNode.ts";
import type EnumNode from "../../src/nodes/EnumNode.ts";
import type FunctionNode from "../../src/nodes/FunctionNode.ts";
import type ParameterNode from "../../src/nodes/ParameterNode.ts";
import type StructNode from "../../src/nodes/StructNode.ts";
import type TraitNode from "../../src/nodes/TraitNode.ts";
import type Type from "../../src/nodes/Type.ts";
import parse from "../../src/parse.ts";

/** A documented member of a type: a field, constructor, method or static function. */
export interface DocMember {
	kind: "field" | "constructor" | "method" | "static" | "case";
	name: string;
	/** The declaration as written in the source (minus `pub`/`inline`), on one line. */
	signature: string;
	doc?: string;
	line: number;
}

/** A documented top-level declaration. */
export interface DocEntry {
	kind: "struct" | "trait" | "enum" | "bitset" | "func" | "const";
	name: string;
	/** `::`-joined namespace from the file's folder (`System::Text`). */
	namespace: string;
	/** Source file, relative to the docs root, with `/` separators. */
	file: string;
	line: number;
	/** The declaration header as written (`mv struct List<T>: Viewable`). */
	signature: string;
	doc?: string;
	type_params: string[];
	/** Traits the type declares conformance to. */
	traits: string[];
	members: DocMember[];
}

export interface DocModel {
	root: string;
	entries: DocEntry[];
	/** One message per top-level `pub` item without a doc comment. */
	warnings: string[];
}

/**
 * Parse every `.nm` file in scope and collect its top-level `pub`
 * declarations (and their public members) into a structured model. Used by
 * `nomen docs` and by the website's API reference.
 */
export function collect_docs(explicit_in?: string): DocModel {
	const root = path.resolve(explicit_in || process.cwd());
	const { files, library, docs_root } = gather_doc_files(root);
	const entries: DocEntry[] = [];
	const warnings: string[] = [];
	for (const file of files) {
		const text = fs.readFileSync(file, "utf8");
		let parsed;
		try {
			parsed = parse(text, library, file);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			warnings.push(`could not parse ${path.relative(root, file)} (${msg})`);
			continue;
		}
		const rel = path.relative(docs_root, file).split(path.sep).join("/");
		const dir = path.posix.dirname(rel);
		const namespace = dir === "." ? "" : dir.split("/").join("::");
		for (const entry of collect_items(parsed.root, text, rel, namespace)) {
			if (!entry.doc) {
				warnings.push(
					`${entry.kind} \`${entry.name}\` has no doc comment (${path.basename(file)}:${entry.line})`,
				);
			}
			entries.push(entry);
		}
	}
	return { root: docs_root, entries, warnings };
}

/**
 * `nomen docs`: write one markdown file per source file into `<root>/docs/`,
 * mirroring the source tree (and, with `json`, the whole model to
 * `<root>/docs/api.json`). Emits a warning for each top-level `pub` item that
 * has no documentation comment.
 */
export function run_docs(explicit_in?: string, options: { json?: boolean } = {}): void {
	const model = collect_docs(explicit_in);
	if (!model.entries.length && !model.warnings.length) {
		console.log(`No documented .nm files found under ${model.root}`);
		return;
	}
	for (const w of model.warnings) console.log(`  warning: ${w}`);

	const out_root = path.join(model.root, "docs");
	const by_file = new Map<string, DocEntry[]>();
	for (const entry of model.entries) {
		const list = by_file.get(entry.file) ?? [];
		list.push(entry);
		by_file.set(entry.file, list);
	}
	for (const [file, entries] of by_file) {
		const out_path = path.join(out_root, file.replace(/\.nm$/, ".md"));
		fs.mkdirSync(path.dirname(out_path), { recursive: true });
		fs.writeFileSync(out_path, render_markdown(file, entries));
	}
	if (options.json) {
		fs.mkdirSync(out_root, { recursive: true });
		const json = { entries: model.entries, warnings: model.warnings };
		fs.writeFileSync(path.join(out_root, "api.json"), JSON.stringify(json, null, "\t") + "\n");
	}

	const warns = model.warnings.length;
	console.log(
		`Wrote ${by_file.size} doc file(s)${options.json ? " and api.json" : ""} to ${out_root}` +
			(warns ? ` with ${warns} warning(s)` : ""),
	);
}

// Decide which files to document. A package.jsonc with `exports` is a library
// (document every exported file); otherwise document the resolved input file
// alongside its module siblings.
function gather_doc_files(root: string): {
	files: string[];
	library: Library | undefined;
	docs_root: string;
} {
	const config_path = path.join(root, "package.jsonc");
	if (fs.existsSync(config_path)) {
		try {
			const raw = fs.readFileSync(config_path, "utf8");
			const json = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
			const parsed = JSON.parse(json);
			if (parsed.exports) {
				let files: string[] = [];
				for (const pattern of Object.values(parsed.exports) as string[]) {
					files = files.concat(resolve_export_files(root, pattern));
				}
				return { files, library: get_library(root), docs_root: root };
			}
		} catch {
			// fall through
		}
	}

	// App / single-file mode: one module folder of siblings.
	const dir = fs.existsSync(root) && fs.lstatSync(root).isDirectory() ? root : path.dirname(root);
	let files: string[] = [];
	try {
		files = fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".nm"))
			.map((f) => path.join(dir, f));
	} catch {
		// unreadable
	}
	return { files, library: resolve_library_for(dir), docs_root: dir };
}

function resolve_library_for(dir: string): Library | undefined {
	let d = dir;
	for (let i = 0; i < 20; i++) {
		const config_path = path.join(d, "package.jsonc");
		if (fs.existsSync(config_path)) {
			try {
				const raw = fs.readFileSync(config_path, "utf8");
				const json = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
				const parsed = JSON.parse(json);
				if (parsed.exports) return get_library(d);
				if (parsed.imports?.System) return get_library(path.resolve(d, parsed.imports.System));
			} catch {
				// ignore
			}
		}
		const lib_config = path.join(d, "core", "package.jsonc");
		if (fs.existsSync(lib_config)) return get_library(path.join(d, "core"));
		const parent = path.dirname(d);
		if (parent === d) break;
		d = parent;
	}
	return undefined;
}

// Collect this file's own top-level pub declarations (those starting before the
// appended library source — i.e. defined in `text`, not pulled in for linking).
function collect_items(
	root_node: BaseNode,
	text: string,
	file: string,
	namespace: string,
): DocEntry[] {
	const items: DocEntry[] = [];
	const statements = (root_node as unknown as { statements: BaseNode[] }).statements;
	const entry = (
		kind: DocEntry["kind"],
		node: BaseNode,
		name: string,
		signature: string,
		extra: Partial<DocEntry> = {},
	): DocEntry => ({
		kind,
		name,
		namespace,
		file,
		line: line_of(text, node.start),
		signature,
		doc: node.doc,
		type_params: [],
		traits: [],
		members: [],
		...extra,
	});
	for (const stmt of statements) {
		if (stmt.start >= text.length) continue;
		switch (stmt.node_type) {
			case "struct": {
				const s = stmt as unknown as StructNode;
				if (s.visibility !== "pub" || s.is_comptime_generated) break;
				items.push(
					entry("struct", s, s.name, type_header(text, s.start), {
						type_params: s.type_params ?? [],
						traits: s.traits ?? [],
						members: [...field_members(text, s.fields), ...function_members(text, s.functions)],
					}),
				);
				break;
			}
			case "trait": {
				const t = stmt as unknown as TraitNode;
				if (t.visibility !== "pub" || t.is_comptime_generated) break;
				items.push(
					entry("trait", t, t.name, type_header(text, t.start), {
						type_params: t.type_params ?? [],
						members: [...field_members(text, t.fields), ...function_members(text, t.functions)],
					}),
				);
				break;
			}
			case "enum": {
				const e = stmt as unknown as EnumNode;
				if (e.visibility !== "pub") break;
				items.push(
					entry("enum", e, e.name, type_header(text, e.start), {
						type_params: e.type_params ?? [],
						members: e.cases.map((c) => ({
							kind: "case" as const,
							name: c.name,
							signature: c.params.length
								? `case ${c.name}(${c.params.map(render_param).join(", ")})`
								: `case ${c.name}`,
							line: line_of(text, c.params[0]?.start ?? e.start),
						})),
					}),
				);
				break;
			}
			case "bitset": {
				const b = stmt as unknown as BitsetNode;
				if (b.visibility !== "pub") break;
				items.push(
					entry("bitset", b, b.name, type_header(text, b.start), {
						members: b.cases.map((c) => ({
							kind: "case" as const,
							name: c,
							signature: c,
							line: line_of(text, b.start),
						})),
					}),
				);
				break;
			}
			case "func": {
				const f = stmt as unknown as FunctionNode;
				if (f.visibility !== "pub") break;
				items.push(entry("func", f, f.name, function_header(text, f.start)));
				break;
			}
			case "declare": {
				const d = stmt as unknown as DeclarationNode;
				if (d.visibility !== "pub") break;
				items.push(entry("const", d, d.name, line_header(text, d.start)));
				break;
			}
		}
	}
	return items;
}

function field_members(text: string, fields: DeclarationNode[]): DocMember[] {
	return fields
		.filter((f) => f.visibility === "pub" && f.start < text.length && f.start > 0)
		.map((f) => ({
			kind: "field",
			name: f.name,
			signature: line_header(text, f.start),
			doc: f.doc,
			line: line_of(text, f.start),
		}));
}

function function_members(text: string, functions: FunctionNode[]): DocMember[] {
	const members: DocMember[] = [];
	for (const f of functions) {
		if (f.visibility !== "pub" || f.is_synthesized_init || f.is_synthesized_copy) continue;
		if (f.start <= 0 || f.start >= text.length) continue;
		// Operators and lifecycle hooks (`#op_add`, `#destroy`) aren't called by
		// name; constructors are.
		if (f.name.startsWith("#") && f.name !== "#init") continue;
		const signature = function_header(text, f.start);
		if (!signature) continue;
		const is_static = !f.params.some((p) => p.is_self_param);
		members.push({
			kind: f.name === "#init" ? "constructor" : is_static ? "static" : "method",
			name: f.name,
			signature,
			doc: f.doc,
			line: line_of(text, f.start),
		});
	}
	return members;
}

// --- Source-faithful headers -------------------------------------------------

// A node's `start` can sit past its modifiers (`pub mv struct` starts at
// `struct`), so headers are read from the start of its line.
function line_start(text: string, start: number): number {
	return text.lastIndexOf("\n", start - 1) + 1;
}

/** Drop the modifiers that don't belong in a reader's signature. */
function tidy(header: string): string {
	return header
		.trim()
		.replace(/\s*\n\s*/g, " ")
		.replace(/\(\s+/g, "(")
		.replace(/,?\s+\)/g, ")")
		.replace(/^(?:(?:pub|inline)\s+)+/, "")
		.trim();
}

/** `struct List<T>: Viewable` — everything before the body's `{`. */
function type_header(text: string, start: number): string {
	const from = line_start(text, start);
	const brace = scan_to(text, start, "{");
	return tidy(text.slice(from, brace));
}

/** `func push = (ref self { items }, mv T value)` — up to the parameter
 *  list's closing parenthesis. Empty if the source isn't a `func … = (…)`. */
function function_header(text: string, start: number): string {
	const from = line_start(text, start);
	const eq = text.indexOf("=", start);
	const open = eq < 0 ? -1 : text.indexOf("(", eq);
	if (
		open < 0 ||
		text
			.slice(eq + 1, open)
			.trim()
			.replace(/^<[^>]*>$/, "") !== ""
	)
		return "";
	const close = scan_to(text, open + 1, ")");
	return tidy(text.slice(from, close + 1));
}

/** `var length = 0` — the declaration's line without its trailing comment. */
function line_header(text: string, start: number): string {
	const from = line_start(text, start);
	let end = text.indexOf("\n", start);
	if (end < 0) end = text.length;
	return tidy(strip_line_comment(text.slice(from, end)));
}

function strip_line_comment(line: string): string {
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = "";
		} else if (c === '"' || c === "'" || c === "`") {
			quote = c;
		} else if (c === "/" && line[i + 1] === "/") {
			return line.slice(0, i);
		}
	}
	return line;
}

/** Index of the first `target` at bracket depth 0 from `from`, skipping
 *  strings and comments. Returns `text.length` if there is none. */
function scan_to(text: string, from: number, target: string): number {
	let depth = 0;
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		if (c === '"' || c === "'" || c === "`") {
			for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
			continue;
		}
		if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (depth === 0 && c === target) return i;
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
	}
	return text.length;
}

// --- Markdown ----------------------------------------------------------------

function render_markdown(file: string, entries: DocEntry[]): string {
	const lines: string[] = [];
	lines.push(`# ${path.posix.basename(file, ".nm")}`);
	lines.push("");
	for (const entry of entries) {
		lines.push(`## \`${entry.signature}\``);
		lines.push("");
		lines.push(entry.doc ?? "_No documentation._");
		lines.push("");
		if (entry.members.length) {
			lines.push("**Members:**");
			lines.push("");
			for (const m of entry.members) {
				const doc = m.doc ? ` — ${m.doc.split("\n")[0]}` : "";
				lines.push(`- \`${m.signature}\`${doc}`);
			}
			lines.push("");
		}
	}
	return lines.join("\n");
}

function render_param(p: ParameterNode): string {
	return `${render_type(p.type)}${p.name ? " " + p.name : ""}`;
}

function render_type(t: Type): string {
	let s = t.name;
	if (t.type_args?.length) s += `<${t.type_args.map(render_type).join(", ")}>`;
	if (t.is_nullable) s += "?";
	if (t.is_ref) s = `ref ${s}`;
	return s;
}

function line_of(source: string, start: number): number {
	let line = 1;
	for (let i = 0; i < start && i < source.length; i++) if (source[i] === "\n") line++;
	return line;
}
