import fs from "node:fs";
import path from "node:path";

import { get_library, resolve_export_files, type Library } from "../../src/lib.ts";
import type BaseNode from "../../src/nodes/BaseNode.ts";
import type BitsetNode from "../../src/nodes/BitsetNode.ts";
import type EnumNode from "../../src/nodes/EnumNode.ts";
import type FunctionNode from "../../src/nodes/FunctionNode.ts";
import type StructNode from "../../src/nodes/StructNode.ts";
import type TraitNode from "../../src/nodes/TraitNode.ts";
import type Type from "../../src/nodes/Type.ts";
import parse from "../../src/parse.ts";

interface DocItem {
	kind: string;
	name: string;
	signature?: string;
	doc?: string;
	node: BaseNode;
}

/**
 * `nomen docs`: parse every `.nm` file in scope, then write one markdown file per
 * source file into `<root>/docs/`, mirroring the source tree. Emits a warning
 * for each top-level `pub` item that has no documentation comment.
 */
export function run_docs(explicit_in?: string): void {
	const root = path.resolve(explicit_in || process.cwd());
	const { files, library, docs_root } = gather_doc_files(root);
	if (!files.length) {
		console.log(`No .nm files found under ${root}`);
		return;
	}

	let warnings = 0;
	let written = 0;
	for (const file of files) {
		const text = fs.readFileSync(file, "utf8");
		let parsed;
		try {
			parsed = parse(text, library, file);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`  warning: could not parse ${path.relative(root, file)} (${msg})`);
			continue;
		}
		const items = collect_items(parsed.root, text.length);
		if (!items.length) continue;

		const rel = path.relative(docs_root, file).replace(/\.nm$/, ".md");
		const out_path = path.join(docs_root, "docs", rel);
		const { markdown, warns } = render_file(file, items, text);
		warnings += warns;
		fs.mkdirSync(path.dirname(out_path), { recursive: true });
		fs.writeFileSync(out_path, markdown);
		written++;
	}

	console.log(
		`Wrote ${written} doc file(s) to ${path.join(docs_root, "docs")}` +
			(warnings ? ` with ${warnings} warning(s)` : ""),
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
function collect_items(root_node: BaseNode, user_length: number): DocItem[] {
	const items: DocItem[] = [];
	const statements = (root_node as unknown as { statements: BaseNode[] }).statements;
	for (const stmt of statements) {
		if (stmt.start >= user_length) continue;
		switch (stmt.node_type) {
			case "struct": {
				const s = stmt as unknown as StructNode;
				if (s.visibility !== "pub") break;
				items.push({
					kind: s.is_class ? "class" : "struct",
					name: s.name,
					doc: s.doc,
					node: s,
				});
				break;
			}
			case "trait": {
				const t = stmt as unknown as TraitNode;
				if (t.visibility !== "pub") break;
				items.push({ kind: "trait", name: t.name, doc: t.doc, node: t });
				break;
			}
			case "enum": {
				const e = stmt as unknown as EnumNode;
				if (e.visibility !== "pub") break;
				items.push({ kind: "enum", name: e.name, doc: e.doc, node: e });
				break;
			}
			case "bitset": {
				const b = stmt as unknown as BitsetNode;
				if (b.visibility !== "pub") break;
				items.push({ kind: "bitset", name: b.name, doc: b.doc, node: b });
				break;
			}
			case "func": {
				const f = stmt as unknown as FunctionNode;
				if (f.visibility !== "pub") break;
				items.push({
					kind: "func",
					name: f.name,
					signature: signature_of(f),
					doc: f.doc,
					node: f,
				});
				break;
			}
		}
	}
	return items;
}

function render_file(
	file: string,
	items: DocItem[],
	source: string,
): { markdown: string; warns: number } {
	const lines: string[] = [];
	const title = path.basename(file, ".nm");
	lines.push(`# ${title}`);
	lines.push("");

	let warns = 0;
	for (const item of items) {
		const where = `${path.basename(file)}:${line_of(source, item.node.start)}`;
		lines.push(`## \`${heading_of(item)}\``);
		lines.push("");
		if (item.doc) {
			lines.push(item.doc);
		} else {
			lines.push(`_No documentation._`);
			console.log(`  warning: ${item.kind} \`${item.name}\` has no doc comment (${where})`);
			warns++;
		}
		lines.push("");

		// Struct/trait: list pub members.
		const members = members_of(item.node);
		if (members.length) {
			lines.push("**Members:**");
			lines.push("");
			for (const m of members) {
				const sig = signature_of(m);
				const doc = m.doc ? ` — ${m.doc.split("\n")[0]}` : "";
				lines.push(`- \`${sig}\`${doc}`);
			}
			lines.push("");
		}
	}
	return { markdown: lines.join("\n"), warns };
}

function heading_of(item: DocItem): string {
	if (item.kind === "func") return `func ${item.name}${item.signature ?? ""}`;
	const generic = generic_params_of(item.node);
	return `${item.kind} ${item.name}${generic}`;
}

// Render a function signature like `name(type name, …) -> Ret`, omitting the
// implicit `self` parameter of methods.
function signature_of(fn: FunctionNode): string {
	const params = fn.params
		.filter((p) => !p.is_self_param)
		.map((p) => `${render_type(p.type)}${p.name ? " " + p.name : ""}`);
	let sig = `${fn.name}(${params.join(", ")})`;
	if (fn.return_type?.name) sig += ` -> ${render_type(fn.return_type)}`;
	return sig;
}

function members_of(node: BaseNode): FunctionNode[] {
	if (node.node_type === "struct" || node.node_type === "trait") {
		const n = node as unknown as { functions: FunctionNode[] };
		return n.functions.filter((f) => f.visibility === "pub" && !f.name.startsWith("#"));
	}
	return [];
}

function generic_params_of(node: BaseNode): string {
	const n = node as unknown as { type_params?: string[] };
	if (n.type_params && n.type_params.length) return `<${n.type_params.join(", ")}>`;
	return "";
}

function render_type(t: Type): string {
	let s = t.name;
	if (t.type_args?.length) s += `<${t.type_args.map(render_type).join(", ")}>`;
	if (t.is_ref) s = `ref ${s}`;
	if (t.is_view) s = `view ${s}`;
	if (t.is_array) s += "[]";
	return s;
}

function line_of(source: string, start: number): number {
	let line = 1;
	for (let i = 0; i < start && i < source.length; i++) if (source[i] === "\n") line++;
	return line;
}
