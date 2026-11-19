/**
 * Renders the repository's README.md and SPEC.md (plus the front page's intro,
 * feature list and sample program) to HTML at build time, with Nomen code
 * blocks highlighted by Shiki. Markdown is parsed with Allmark. Run via `pnpm docs`; `dev` and `build`
 * regenerate it automatically.
 *
 * The output is plain HTML strings in `src/lib/docs/*.generated.ts`, so the
 * pages never load Markdown or Shiki at runtime. Shiki's inline colour styles
 * are folded into a few shared classes (`src/assets/highlight.generated.css`)
 * to keep the generated HTML small.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gfm, htmlRenderers, type MarkdownNode, parse, render as render_html } from "allmark";
import { codeToHtml } from "nomen-shiki";

import { encode_source } from "../src/lib/share.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const out_dir = path.join(repo, "site/src/lib/docs");
const css_file = path.join(repo, "site/src/assets/highlight.generated.css");
const GITHUB = "https://github.com/andrewjk/nomen/blob/main";
// The front page's sample: a short tour of the headline features.
const SAMPLE_FILE = "site/src/samples/tour.nm";

interface TocEntry {
	depth: number;
	id: string;
	text: string;
}

// Shiki's inline `style="…"` strings → shared class names.
const style_classes = new Map<string, string>();

function classify_styles(html: string): string {
	return html.replace(/ style="([^"]*)"/g, (_match, style: string) => {
		// The <pre>'s own background/foreground comes from the site CSS.
		if (style.includes("background-color")) return "";
		let name = style_classes.get(style);
		if (!name) {
			name = `h${style_classes.size}`;
			style_classes.set(style, name);
		}
		return ` class="${name}"`;
	});
}

/** The text of rendered inline HTML (the TOC is inserted as text, not HTML). */
function strip_html(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

function escape_html(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function highlight(code: string, lang: string): Promise<string> {
	// Unlabelled fences in the docs are Nomen (the SPEC coverage tests compile
	// them as such); anything else (bash) is shown plain.
	if (lang === "" || lang === "nomen" || lang === "nm") {
		const html = await codeToHtml(code, { lang: "nomen", theme: "dark-plus" });
		return classify_styles(html).replace(
			/<pre class="shiki dark-plus"[^>]*>/,
			'<pre class="shiki">',
		);
	}
	return `<pre class="shiki"><code>${escape_html(code)}</code></pre>`;
}

/** GitHub-style heading slugs, so the docs' own `#anchor` links keep working. */
function slugger(): (text: string) => string {
	const seen = new Map<string, number>();
	return (text) => {
		const base = text
			.toLowerCase()
			.trim()
			.replace(/[^\p{L}\p{N}\s_-]/gu, "")
			.replace(/\s/g, "-");
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return count === 0 ? base : `${base}-${count}`;
	};
}

/** Links between the docs stay on the site; other repository files go to GitHub. */
function rewrite_href(href: string, source_dir: string): string {
	if (/^([a-z]+:|#|\/)/i.test(href)) return href;
	const [file, hash] = href.split("#");
	const resolved = path.posix.normalize(path.posix.join(source_dir, file));
	const suffix = hash ? `#${hash}` : "";
	if (resolved === "README.md") return `/readme${suffix}`;
	if (resolved === "SPEC.md") return `/spec${suffix}`;
	// SPEC.md refers to its sibling docs by bare name (MEMORY.md, ASYNC.md),
	// but they live in docs/.
	let target = resolved;
	if (!fs.existsSync(path.join(repo, target)) && fs.existsSync(path.join(repo, "docs", target))) {
		target = `docs/${target}`;
	}
	const kind =
		fs.existsSync(path.join(repo, target)) && fs.statSync(path.join(repo, target)).isDirectory()
			? "tree"
			: "blob";
	return `${GITHUB.replace("/blob/", `/${kind}/`)}/${target}${suffix}`;
}

type Renderer = (typeof htmlRenderers)[number];
type RenderState = Parameters<Renderer["render"]>[1];

function default_renderer(name: string): Renderer {
	const renderer = htmlRenderers.find((r) => r.name === name);
	if (!renderer) throw new Error(`allmark has no "${name}" renderer`);
	return renderer;
}

/** Runs a renderer into a scratch buffer and returns the HTML it produced. */
function capture(renderer: Renderer, node: MarkdownNode, state: RenderState): string {
	const saved = state.output;
	state.output = "";
	renderer.render(node, state);
	const html = state.output;
	state.output = saved;
	return html;
}

/** Appends a block's HTML on its own line, as Allmark's block renderers do. */
function append_block(html: string, state: RenderState): void {
	if (state.output.length && !state.output.endsWith("\n")) state.output += "\n";
	state.output += html.endsWith("\n") ? html : `${html}\n`;
}

/** Visits every node in the tree. */
function* walk(node: MarkdownNode): Generator<MarkdownNode> {
	yield node;
	for (const child of node.children ?? []) yield* walk(child);
}

async function render(
	markdown: string,
	source_dir = "",
): Promise<{ html: string; toc: TocEntry[] }> {
	const doc = parse(markdown, gfm);

	// Allmark renders synchronously and Shiki is async, so highlight every code
	// block up front. Links are rewritten in place while we're here.
	const highlighted = new Map<MarkdownNode, string>();
	for (const node of walk(doc)) {
		if (node.type === "code_fence" || (node.type === "code_block" && node.content.length)) {
			const lang = (node.info ?? "").trim().split(" ")[0];
			// The block's content keeps its final newline; Shiki would render it
			// as an empty last line.
			highlighted.set(node, await highlight(node.content.replace(/\n$/, ""), lang));
		} else if (node.type === "link" && node.info !== undefined) {
			node.info = rewrite_href(node.info, source_dir);
		}
	}

	const code: Renderer = {
		name: "code_fence",
		render: (node, state) => append_block(highlighted.get(node) ?? "", state),
	};

	// Headings get GitHub-style ids (and link to themselves); h2/h3 go in the TOC.
	const toc: TocEntry[] = [];
	const slug = slugger();
	const heading = (name: string): Renderer => {
		const base = default_renderer(name);
		return {
			name,
			render: (node, state) => {
				const html = capture(base, node, state);
				const match = html.match(/<h(\d)>([\s\S]*)<\/h\1>/);
				if (!match) return append_block(html, state);
				const depth = Number(match[1]);
				const inner = match[2];
				const id = slug(strip_html(inner));
				if (depth >= 2 && depth <= 3) toc.push({ depth, id, text: strip_html(inner) });
				append_block(
					`<h${depth} id="${id}"><a class="anchor" href="#${id}">${inner}</a></h${depth}>`,
					state,
				);
			},
		};
	};

	const overrides = [
		code,
		{ ...code, name: "code_block" },
		heading("heading"),
		heading("heading_underline"),
	];
	const renderers = htmlRenderers.map((r) => overrides.find((o) => o.name === r.name) ?? r);
	return { html: render_html(doc, renderers), toc };
}

/** The Markdown under heading `title`, up to the next heading of that depth or
 *  higher (or of any depth with `own_text_only`). */
function section(markdown: string, title: string, own_text_only = false): string {
	const lines = markdown.split("\n");
	const start = lines.findIndex((line) => /^#+ /.test(line) && line.replace(/^#+ /, "") === title);
	if (start < 0) throw new Error(`README.md has no "${title}" section`);
	const depth = lines[start].match(/^#+/)![0].length;
	let end = start + 1;
	let in_fence = false;
	for (; end < lines.length; end++) {
		if (lines[end].startsWith("```")) in_fence = !in_fence;
		const m = !in_fence && lines[end].match(/^(#+) /);
		if (m && (own_text_only || m[1].length <= depth)) break;
	}
	return lines
		.slice(start + 1, end)
		.join("\n")
		.trim();
}

function write_module(name: string, value: unknown): void {
	const file = path.join(out_dir, `${name}.generated.ts`);
	const body =
		"// Generated by site/scripts/render-docs.ts — do not edit.\n" +
		`const doc = ${JSON.stringify(value)};\nexport default doc;\n`;
	fs.writeFileSync(file, body);
}

// `<!-- site:hide -->` … `<!-- /site:hide -->` ranges are for GitHub readers
// only — a link to the site reads as self-referential on the site itself.
// Stripped before rendering, so the README page and the home intro never
// show them.
const strip_site_hidden = (md: string): string =>
	md.replace(/<!--\s*site:hide\s*-->[\s\S]*?<!--\s*\/site:hide\s*-->/g, "");

const readme_md = strip_site_hidden(fs.readFileSync(path.join(repo, "README.md"), "utf8"));
const spec_md = fs.readFileSync(path.join(repo, "SPEC.md"), "utf8");
const sample = fs.readFileSync(path.join(repo, SAMPLE_FILE), "utf8");

fs.mkdirSync(out_dir, { recursive: true });

// The pages carry their own <h1>; drop the documents' title lines.
const strip_title = (md: string): string => md.replace(/^# .*\n/, "");

write_module("readme", await render(strip_title(readme_md)));
write_module("spec", await render(strip_title(spec_md)));
write_module("home", {
	intro: (await render(section(readme_md, "The Nomen Programming Language", true))).html,
	features: (await render(section(readme_md, "Features"))).html,
	sample: await highlight(sample, "nomen"),
	sample_name: path.basename(SAMPLE_FILE),
	sample_href: `/s/${encode_source(sample)}`,
});

const css =
	"/* Generated by site/scripts/render-docs.ts — do not edit. */\n" +
	[...style_classes]
		.map(([style, name]) => `.shiki .${name} { ${style.replace(/;?$/, ";")} }`)
		.join("\n") +
	"\n";
fs.writeFileSync(css_file, css);

console.log(
	`Rendered README.md, SPEC.md and the home page (${style_classes.size} highlight classes)`,
);
