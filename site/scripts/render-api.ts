/**
 * Renders the System library's API reference (`core/System/**\/*.nm`) to HTML
 * at build time: an index at `/docs`, one page per namespace
 * (`/docs/System/Text`) and one per type (`/docs/System/Text/Json`). The
 * declarations come from `nomen docs`'s structured model (`collect_docs` in
 * cli/src/docs.ts), so whatever `core/` contains is documented. Doc comments
 * are Markdown, parsed with Allmark; signatures and code blocks are
 * highlighted by Shiki, and type names in them link to their pages. Run via
 * `pnpm api`; `dev` and `build` regenerate it automatically.
 *
 * Output: `src/lib/docs/api-pages.generated.ts` (every page's HTML),
 * `src/lib/docs/api-nav.generated.ts` (the sidebar) and `src/assets/api-highlight.generated.css` (Shiki's inline colours as
 * classes — kept apart from render-docs.ts's file so the two scripts don't
 * overwrite each other).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gfm, htmlRenderers, type MarkdownNode, parse, render as render_html } from "allmark";
import { codeToHtml } from "nomen-shiki";

import { collect_docs, type DocEntry, type DocMember } from "../../cli/src/docs.ts";
import type { ApiNavNamespace, ApiPage } from "../src/lib/api.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const core = path.join(repo, "core");
const pages_file = path.join(repo, "site/src/lib/docs/api-pages.generated.ts");
const nav_file = path.join(repo, "site/src/lib/docs/api-nav.generated.ts");
const css_file = path.join(repo, "site/src/assets/api-highlight.generated.css");
const GITHUB = "https://github.com/andrewjk/nomen/blob/main/core";

// The routes serve /docs/[a]/[b]/[c] (src/lib/api-server.ts).
const MAX_DEPTH = 3;

const TYPE_KINDS = new Set(["struct", "trait", "enum", "bitset"]);

// --- Highlighting ------------------------------------------------------------

// Shiki's inline `style="…"` strings → shared class names (`a0`, `a1`, …).
const style_classes = new Map<string, string>();

function classify_styles(html: string): string {
	return html.replace(/ style="([^"]*)"/g, (_match, style: string) => {
		if (style.includes("background-color")) return "";
		let name = style_classes.get(style);
		if (!name) {
			name = `a${style_classes.size}`;
			style_classes.set(style, name);
		}
		return ` class="${name}"`;
	});
}

function escape_html(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function highlight(code: string, lang: string, extra_class = ""): Promise<string> {
	const cls = extra_class ? `shiki ${extra_class}` : "shiki";
	if (lang === "" || lang === "nomen" || lang === "nm") {
		const html = await codeToHtml(code, { lang: "nomen", theme: "dark-plus" });
		return classify_styles(html).replace(
			/<pre class="shiki dark-plus"[^>]*>/,
			`<pre class="${cls}">`,
		);
	}
	return `<pre class="${cls}"><code>${escape_html(code)}</code></pre>`;
}

// --- Pages and links -----------------------------------------------------------

const model = collect_docs(core);
const entries = model.entries;

const ns_path = (namespace: string): string => namespace.split("::").join("/");
const ns_href = (namespace: string): string => `/docs/${ns_path(namespace)}`;
const type_href = (e: DocEntry): string => `${ns_href(e.namespace)}/${e.name}`;

// Type name → its entries (a name can exist in more than one namespace).
const types_by_name = new Map<string, DocEntry[]>();
for (const e of entries) {
	if (!TYPE_KINDS.has(e.kind)) continue;
	types_by_name.set(e.name, [...(types_by_name.get(e.name) ?? []), e]);
}

/** The page a type name refers to, from code in `namespace`. */
function resolve_type(name: string, namespace: string): DocEntry | undefined {
	const found = types_by_name.get(name);
	if (!found) return undefined;
	return found.find((e) => e.namespace === namespace) ?? found[0];
}

/** Wraps each known type name in highlighted code with a link to its page. */
function link_types(html: string, namespace: string, self?: DocEntry): string {
	return html.replace(/>([^<]+)</g, (_m, text: string) => {
		const linked = text.replace(/\b[A-Za-z_]\w*\b/g, (word) => {
			const target = resolve_type(word, namespace);
			if (!target || target === self) return word;
			return `<a href="${type_href(target)}">${word}</a>`;
		});
		return `>${linked}<`;
	});
}

/** Field-effect sets (`ref self { a, b, … }`) longer than a few names are an
 *  implementation detail at API-reading distance; show them as `{ … }`. */
function shorten_field_sets(signature: string): string {
	return signature.replace(/\{([^{}]*)\}/g, (match, names: string) =>
		names.split(",").length > 4 ? "{ … }" : match,
	);
}

async function signature_html(sig: string, namespace: string, self?: DocEntry): Promise<string> {
	return link_types(await highlight(shorten_field_sets(sig), "nomen", "sig"), namespace, self);
}

// --- Markdown ------------------------------------------------------------------

type Renderer = (typeof htmlRenderers)[number];

function* walk(node: MarkdownNode): Generator<MarkdownNode> {
	yield node;
	for (const child of node.children ?? []) yield* walk(child);
}

function append_block(html: string, output: string): string {
	let out = output;
	if (out.length && !out.endsWith("\n")) out += "\n";
	return out + (html.endsWith("\n") ? html : `${html}\n`);
}

/** A doc comment's Markdown as HTML: Nomen code highlighted, raw HTML shown
 *  as text (`List<T>` in prose is a type, not a tag), and inline code that
 *  names a type linked to it. */
async function markdown(text: string, namespace: string): Promise<string> {
	const doc = parse(text, gfm);
	const highlighted = new Map<MarkdownNode, string>();
	for (const node of walk(doc)) {
		if (node.type === "code_fence" || (node.type === "code_block" && node.content.length)) {
			const lang = (node.info ?? "").trim().split(" ")[0];
			const html = await highlight(node.content.replace(/\n$/, ""), lang);
			highlighted.set(node, link_types(html, namespace));
		}
	}
	const code: Renderer = {
		name: "code_fence",
		render: (node, state) => {
			state.output = append_block(highlighted.get(node) ?? "", state.output);
		},
	};
	const raw_html = (name: string): Renderer => ({
		name,
		render: (node, state) => {
			state.output += escape_html(node.markup + node.content);
		},
	});
	const overrides = [
		code,
		{ ...code, name: "code_block" },
		raw_html("html_span"),
		raw_html("html_block"),
	];
	const renderers = htmlRenderers.map((r) => overrides.find((o) => o.name === r.name) ?? r);
	return render_html(doc, renderers).replace(/<code>([A-Za-z_]\w*)<\/code>/g, (match, name) => {
		const target = resolve_type(name, namespace);
		return target ? `<a href="${type_href(target)}">${match}</a>` : match;
	});
}

/** The first paragraph of a doc comment, as inline HTML. */
async function summary(doc: string | undefined, namespace: string): Promise<string> {
	if (!doc) return "";
	const first = doc.split(/\n\s*\n/)[0];
	return (await markdown(first, namespace))
		.trim()
		.replace(/^<p>/, "")
		.replace(/<\/p>$/, "");
}

/** Plain text for `<meta name="description">`. */
function plain(doc: string | undefined, fallback: string): string {
	if (!doc) return fallback;
	const text = doc
		.split(/\n\s*\n/)[0]
		.replace(/`/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

// --- Page bodies -------------------------------------------------------------------

const MEMBER_GROUPS: { kind: DocMember["kind"]; title: string }[] = [
	{ kind: "case", title: "Cases" },
	{ kind: "field", title: "Fields" },
	{ kind: "constructor", title: "Constructors" },
	{ kind: "method", title: "Methods" },
	{ kind: "static", title: "Static functions" },
];

const KIND_LABEL: Record<DocEntry["kind"], string> = {
	struct: "struct",
	trait: "trait",
	enum: "enum",
	bitset: "bitset",
	func: "function",
	const: "constant",
};

function source_link(file: string, line: number): string {
	return `<a class="source" href="${GITHUB}/${file}#L${line}" rel="noopener">Source</a>`;
}

/** A member's anchor: its name (`#init` → `init`), numbered when overloaded. */
function anchor_maker(): (name: string) => string {
	const seen = new Map<string, number>();
	return (name) => {
		const base = name.replace(/^#/, "").replace(/[^\w-]/g, "") || "member";
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		return n === 0 ? base : `${base}-${n}`;
	};
}

async function member_html(
	m: DocMember,
	id: string,
	entry: DocEntry,
	heading: string,
): Promise<string> {
	const parts = [
		`<section class="member" id="${id}">`,
		`<${heading} class="member-name"><a class="anchor" href="#${id}">${escape_html(m.name)}</a>${source_link(entry.file, m.line)}</${heading}>`,
		await signature_html(m.signature, entry.namespace, entry),
	];
	if (m.doc) parts.push(`<div class="member-doc">${await markdown(m.doc, entry.namespace)}</div>`);
	parts.push("</section>");
	return parts.join("\n");
}

function breadcrumbs(namespace: string, last?: string): string {
	const crumbs = [`<a href="/docs">API</a>`];
	const parts = namespace.split("::");
	parts.forEach((part, i) => {
		const ns = parts.slice(0, i + 1).join("::");
		crumbs.push(
			i === parts.length - 1 && !last
				? `<span>${part}</span>`
				: `<a href="${ns_href(ns)}">${part}</a>`,
		);
	});
	if (last) crumbs.push(`<span>${escape_html(last)}</span>`);
	return `<nav class="crumbs">${crumbs.join('<span class="sep">/</span>')}</nav>`;
}

async function type_page(entry: DocEntry): Promise<ApiPage> {
	const html: string[] = [
		breadcrumbs(entry.namespace, entry.name),
		`<h1>${escape_html(entry.name)} <span class="kind">${KIND_LABEL[entry.kind]}</span></h1>`,
		await signature_html(entry.signature, entry.namespace, entry),
	];
	if (entry.traits.length) {
		const traits = entry.traits.map((t) => {
			const target = resolve_type(t, entry.namespace);
			return target ? `<a href="${type_href(target)}"><code>${t}</code></a>` : `<code>${t}</code>`;
		});
		html.push(`<p class="conforms">Conforms to ${traits.join(", ")}</p>`);
	}
	html.push(
		entry.doc
			? await markdown(entry.doc, entry.namespace)
			: `<p class="undocumented">No documentation.</p>`,
	);
	html.push(
		`<p class="source-line">${source_link(entry.file, entry.line)} · <code>core/${entry.file}</code></p>`,
	);

	const anchor = anchor_maker();
	const toc: ApiPage["toc"] = [];
	for (const group of MEMBER_GROUPS) {
		const members = entry.members.filter((m) => m.kind === group.kind);
		if (!members.length) continue;
		const group_id = anchor(group.title.toLowerCase().replace(/ /g, "-"));
		html.push(`<h2 id="${group_id}"><a class="anchor" href="#${group_id}">${group.title}</a></h2>`);
		toc.push({ id: group_id, text: group.title, depth: 2 });
		// Cases and fields are short: no headings, and a run of undocumented
		// ones shares one code block, like the type's own body.
		if (group.kind === "case" || group.kind === "field") {
			let run: string[] = [];
			const flush = async (): Promise<void> => {
				if (!run.length) return;
				const sig = await signature_html(run.join("\n"), entry.namespace, entry);
				html.push(`<div class="member compact">${sig}</div>`);
				run = [];
			};
			for (const m of members) {
				if (!m.doc) {
					run.push(m.signature);
					continue;
				}
				await flush();
				const sig = await signature_html(m.signature, entry.namespace, entry);
				const doc = await markdown(m.doc, entry.namespace);
				html.push(
					`<div class="member compact" id="${anchor(m.name)}">${sig}<div class="member-doc">${doc}</div></div>`,
				);
			}
			await flush();
			continue;
		}
		for (const m of members) {
			const id = anchor(m.name);
			toc.push({ id, text: m.kind === "constructor" ? entry.name : m.name, depth: 3 });
			html.push(await member_html(m, id, entry, "h3"));
		}
	}

	return {
		path: `${ns_path(entry.namespace)}/${entry.name}`,
		title: `${entry.name} — ${entry.namespace}`,
		description: plain(
			entry.doc,
			`The ${entry.name} ${KIND_LABEL[entry.kind]} in ${entry.namespace}.`,
		),
		html: html.join("\n"),
		toc,
	};
}

async function type_list(list: DocEntry[]): Promise<string> {
	const rows: string[] = [];
	for (const e of list) {
		rows.push(
			`<li><a href="${type_href(e)}"><code>${escape_html(e.name)}</code></a><span class="kind">${KIND_LABEL[e.kind]}</span><span class="summary">${await summary(e.doc, e.namespace)}</span></li>`,
		);
	}
	return `<ul class="type-list">\n${rows.join("\n")}\n</ul>`;
}

/** "58 types, 1 function" — what a namespace page holds. */
function count_label(list: DocEntry[]): string {
	const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
	const parts = [plural(list.filter((e) => TYPE_KINDS.has(e.kind)).length, "type")];
	const funcs = list.filter((e) => e.kind === "func").length;
	const consts = list.filter((e) => e.kind === "const").length;
	if (funcs) parts.push(plural(funcs, "function"));
	if (consts) parts.push(plural(consts, "constant"));
	return parts.join(", ");
}

async function namespace_page(namespace: string, list: DocEntry[]): Promise<ApiPage> {
	const types = list.filter((e) => TYPE_KINDS.has(e.kind));
	const others = list.filter((e) => !TYPE_KINDS.has(e.kind));
	const html: string[] = [breadcrumbs(namespace), `<h1>${namespace}</h1>`];
	const import_line = `import ${namespace}`;
	html.push(await highlight(import_line, "nomen"));
	const toc: ApiPage["toc"] = [];
	if (types.length) {
		html.push(`<h2 id="types"><a class="anchor" href="#types">Types</a></h2>`);
		html.push(await type_list(types));
		toc.push({ id: "types", text: "Types", depth: 2 });
	}
	const anchor = anchor_maker();
	for (const [kind, title] of [
		["func", "Functions"],
		["const", "Constants"],
	] as const) {
		const members = others.filter((e) => e.kind === kind);
		if (!members.length) continue;
		const id = title.toLowerCase();
		html.push(`<h2 id="${id}"><a class="anchor" href="#${id}">${title}</a></h2>`);
		toc.push({ id, text: title, depth: 2 });
		for (const e of members) {
			const m_id = anchor(e.name);
			if (kind === "func") toc.push({ id: m_id, text: e.name, depth: 3 });
			const as_member: DocMember = {
				kind: "static",
				name: e.name,
				signature: e.signature,
				doc: e.doc,
				line: e.line,
			};
			html.push(await member_html(as_member, m_id, e, "h3"));
		}
	}
	return {
		path: ns_path(namespace),
		title: `${namespace} — Nomen API`,
		description: `Types${others.length ? ", functions and constants" : ""} in the ${namespace} namespace of the Nomen System library.`,
		html: html.join("\n"),
		toc,
	};
}

// --- Assemble ----------------------------------------------------------------------

const by_namespace = new Map<string, DocEntry[]>();
for (const e of entries)
	by_namespace.set(e.namespace, [...(by_namespace.get(e.namespace) ?? []), e]);
// `System` first, then its children alphabetically.
const namespaces = [...by_namespace.keys()].sort((a, b) =>
	a === "System" ? -1 : b === "System" ? 1 : a.localeCompare(b),
);
const by_name = (a: DocEntry, b: DocEntry): number =>
	a.name.localeCompare(b.name, "en", { sensitivity: "base" });

const pages: Record<string, ApiPage> = {};
const nav: ApiNavNamespace[] = [];
const index_html: string[] = [
	`<h1>System Library API</h1>`,
	`<p class="lede">Every public type in the <code>System</code> library that ships with Nomen, generated from the doc comments in <a href="https://github.com/andrewjk/nomen/tree/main/core/System" rel="noopener"><code>core/System</code></a>. Import a namespace to use its types:</p>`,
	await highlight("import System\nimport System::Text", "nomen"),
];
const index_toc: ApiPage["toc"] = [];

for (const namespace of namespaces) {
	const list = by_namespace.get(namespace)!.sort(by_name);
	const types = list.filter((e) => TYPE_KINDS.has(e.kind));
	const page = await namespace_page(namespace, list);
	pages[page.path] = page;
	nav.push({
		name: namespace,
		href: ns_href(namespace),
		types: types.map((e) => ({ name: e.name, href: type_href(e) })),
	});
	for (const e of types) {
		const tp = await type_page(e);
		if (pages[tp.path]) throw new Error(`Two API pages map to /docs/${tp.path}`);
		if (tp.path.split("/").length > MAX_DEPTH) {
			throw new Error(
				`/docs/${tp.path} is deeper than the routes serve: add a level to src/lib/api-server.ts and src/routes/docs/`,
			);
		}
		pages[tp.path] = tp;
	}

	const id = namespace.toLowerCase().replace(/::/g, "-");
	index_html.push(
		`<h2 id="${id}"><a class="anchor" href="#${id}">${namespace}</a></h2>`,
		`<p><a href="${ns_href(namespace)}">${count_label(list)} →</a></p>`,
		await type_list(types),
	);
	index_toc.push({ id, text: namespace, depth: 2 });
}

pages[""] = {
	path: "",
	title: "Nomen System Library API",
	description:
		"API reference for the Nomen System library: collections, text, streams, concurrency and UI controls.",
	html: index_html.join("\n"),
	toc: index_toc,
};

// The pages are loaded on the server (and prerendered); only the small
// sidebar data is imported by the page component, so it alone reaches the
// client bundle.
fs.mkdirSync(path.dirname(pages_file), { recursive: true });
const header = "// Generated by site/scripts/render-api.ts — do not edit.\n";
fs.writeFileSync(
	pages_file,
	header +
		'import type { ApiPage } from "../api.ts";\n' +
		`const pages: Record<string, ApiPage> = ${JSON.stringify(pages)};\nexport default pages;\n`,
);
fs.writeFileSync(
	nav_file,
	header +
		'import type { ApiNavNamespace } from "../api.ts";\n' +
		`const nav: ApiNavNamespace[] = ${JSON.stringify(nav)};\nexport default nav;\n`,
);
fs.writeFileSync(
	css_file,
	"/* Generated by site/scripts/render-api.ts — do not edit. */\n" +
		[...style_classes]
			.map(([style, name]) => `.shiki .${name} { ${style.replace(/;?$/, ";")} }`)
			.join("\n") +
		"\n",
);

const size = fs.statSync(pages_file).size;
console.log(
	`Rendered the API reference: ${Object.keys(pages).length} pages, ${(size / 1024).toFixed(0)} KB (${style_classes.size} highlight classes, ${model.warnings.length} undocumented items)`,
);
