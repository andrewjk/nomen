import { codeToTokens } from "nomen-shiki";

import { render_bitmap_card } from "./card.ts";

/**
 * Renders the per-program social card in a real browser via Cloudflare Browser
 * Run quick actions, with Fira Code and the page's actual syntax colours.
 *
 * The Worker only builds the HTML: `env.BROWSER.quickAction("screenshot", …)`
 * runs Chromium remotely and returns the PNG. That keeps the Worker bundle
 * small (no font rasterizer/WASM) while still producing proper text. When the
 * binding is absent (or the browser call fails), `render_bitmap_card` keeps the
 * share route working.
 *
 * Layout: the code gets the whole left column (75% of the card) and the run
 * output sits beside it (25%), so a long output never steals code lines. The
 * code font shrinks (to a floor) until every line fits, then truncates.
 *
 * The Fira Code subset is a static asset (SIL OFL, see
 * `src/public/fonts/OFL.txt`). It is embedded as a data URL so the screenshot
 * never races an external font request.
 */

const WIDTH = 1200;
const HEIGHT = 630;
const PAD_Y = 40;
const PAD_X = 48;
/** h1 line box + header padding + border + margin (keep in sync with CSS). */
const HEADER_HEIGHT = 59;
const BODY_HEIGHT = HEIGHT - PAD_Y * 2 - HEADER_HEIGHT;
const CONTENT_WIDTH = WIDTH - PAD_X * 2;
const COLUMN_GAP = 24;
/** Code column share when output is shown: 75% code / 25% output. */
const CODE_FRACTION = 0.75;
const OUTPUT_PADDING = 20;
/** Fira Code's advance width is 0.6em. */
const ADVANCE_EM = 0.6;
const LINE_HEIGHT_RATIO = 1.45;
/** Try the largest first; never go below the last entry. */
const FONT_SIZES = [18, 17, 16, 15, 14, 13, 12, 11, 10];
const MIN_FONT_SIZE = FONT_SIZES[FONT_SIZES.length - 1];

const FONT_URL = "/fonts/fira-code.woff2";
const TOKEN_FALLBACK = "#d4d4d4";
const OUTPUT_COLOR = "#9aa4b2";
const MUTED = "#6f7885";

interface ScreenshotOptions {
	html: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
}

export interface BrowserBinding {
	quickAction(name: "screenshot", options: ScreenshotOptions): Promise<Response>;
}

export interface AssetsBinding {
	fetch(input: RequestInfo | URL): Promise<Response>;
}

export interface CardEnv {
	BROWSER?: BrowserBinding;
	ASSETS?: AssetsBinding;
}

interface TokenLine {
	text: string;
	color: string;
}

interface CardLayout {
	fontSize: number;
	lineHeight: number;
	split: boolean;
	/** Wrapped output lines at the chosen font size. */
	output: string[];
	maxOutputLines: number;
	maxCodeLines: number;
}

let font_promise: Promise<string> | undefined;

export interface CardRenderResult {
	png: ArrayBuffer;
	/** True when the bitmap fallback was used (don't cache it as immutable). */
	fallback: boolean;
}

/** Render the card through Browser Run, falling back to the bitmap renderer. */
export async function render_code_card(
	env: CardEnv | undefined,
	url: URL,
	source: string,
	output: string | undefined,
	host: string,
): Promise<CardRenderResult> {
	if (env?.BROWSER && env.ASSETS) {
		try {
			const html = await build_card_html(env, url, source, output, host);
			const response = await env.BROWSER.quickAction("screenshot", {
				html,
				viewport: { width: WIDTH, height: HEIGHT },
			});
			if (!response.ok) {
				throw new Error(`Browser Run screenshot failed: ${response.status}`);
			}
			const png = await response.arrayBuffer();
			if (png.byteLength < 100) throw new Error("Browser Run returned an empty screenshot");
			return { png, fallback: false };
		} catch (error) {
			console.error("browser share-card render failed; using the bitmap fallback:", error);
		}
	}
	return { png: await render_bitmap_card(source, output, host), fallback: true };
}

/** Build the complete screenshot page. Exported for tests. */
export async function build_card_html(
	env: CardEnv,
	url: URL,
	source: string,
	output: string | undefined,
	host: string,
): Promise<string> {
	const font = await load_font(env, url);
	const lines = await highlighted_lines(source);
	const raw_output = (output ?? "").replace(/\r\n?/g, "\n").split("\n");
	while (raw_output.length > 0 && raw_output[raw_output.length - 1].trim() === "") {
		raw_output.pop();
	}

	const layout = layout_card(lines, raw_output);
	const code_truncated = lines.length > layout.maxCodeLines;
	const shown_code = code_truncated ? Math.max(0, layout.maxCodeLines - 1) : lines.length;
	const code_html = lines
		.slice(0, shown_code)
		.map((line) => token_line_html(line))
		.join("");
	const code_ellipsis = code_truncated ? `<div class="line muted">...</div>` : "";

	let output_html = "";
	if (layout.split) {
		const output_truncated = layout.output.length > layout.maxOutputLines;
		const shown = output_truncated
			? layout.output.slice(0, Math.max(0, layout.maxOutputLines - 1))
			: layout.output;
		if (output_truncated) shown.push("...");
		output_html = `<div class="output" style="font-size:${layout.fontSize}px;line-height:${layout.lineHeight}px">${shown
			.map((line) => `<div class="line">${escape_html(line) || "&#160;"}</div>`)
			.join("")}</div>`;
	}

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
@font-face {
	font-family: "Fira Code";
	src: url(data:font/woff2;base64,${font}) format("woff2");
	font-weight: 400 700;
	font-style: normal;
	font-display: block;
}
* { box-sizing: border-box; }
html, body {
	margin: 0;
	width: ${WIDTH}px;
	height: ${HEIGHT}px;
	overflow: hidden;
	background: #101214;
}
body {
	font-family: "Fira Code", ui-monospace, monospace;
	font-feature-settings: "liga" 0, "calt" 0;
	-webkit-font-smoothing: antialiased;
	color: #d4d4d4;
}
.card {
	display: flex;
	flex-direction: column;
	width: ${WIDTH}px;
	height: ${HEIGHT}px;
	padding: ${PAD_Y}px ${PAD_X}px;
}
header {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	flex: 0 0 auto;
	padding-bottom: 12px;
	margin-bottom: 18px;
	border-bottom: 1px solid #262d36;
}
h1 {
	margin: 0;
	font-size: 22px;
	line-height: 28px;
	font-weight: 700;
	letter-spacing: -0.3px;
	color: #e6e9ee;
}
h1 span { color: #8ab4f8; }
.host { font-size: 14px; line-height: 28px; color: ${MUTED}; }
.body {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: ${COLUMN_GAP}px;
	flex: 1;
	min-height: 0;
}
.body.split { grid-template-columns: 3fr 1fr; }
.code {
	overflow: hidden;
	white-space: pre;
}
.output {
	border-left: 1px solid #262d36;
	padding-left: ${OUTPUT_PADDING}px;
	overflow: hidden;
	white-space: pre;
	color: ${OUTPUT_COLOR};
}
.line { white-space: pre; }
.muted { color: ${MUTED}; }
</style>
</head>
<body>
<div class="card">
<header><h1>Nomen <span>Playground</span></h1><div class="host">${escape_html(host)}</div></header>
<div class="body${layout.split ? " split" : ""}">
<div class="code" style="font-size:${layout.fontSize}px;line-height:${layout.lineHeight}px">${code_html}${code_ellipsis}</div>
${output_html}
</div>
</div>
</body>
</html>`;
}

/** Pick the largest code font that fits the code column; wrap/limit output. */
function layout_card(lines: TokenLine[][], raw_output: string[]): CardLayout {
	const split = raw_output.length > 0;
	const code_width = split
		? Math.floor((CONTENT_WIDTH - COLUMN_GAP) * CODE_FRACTION)
		: CONTENT_WIDTH;
	const output_width = split ? CONTENT_WIDTH - COLUMN_GAP - code_width - OUTPUT_PADDING : 0;
	const max_code_columns = Math.max(0, ...lines.map(line_width));

	let fontSize = MIN_FONT_SIZE;
	for (const size of FONT_SIZES) {
		const line_height = Math.round(size * LINE_HEIGHT_RATIO);
		if (
			lines.length * line_height <= BODY_HEIGHT &&
			max_code_columns * size * ADVANCE_EM <= code_width
		) {
			fontSize = size;
			break;
		}
	}

	const lineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO);
	const output_columns = split
		? Math.max(1, Math.floor(output_width / (fontSize * ADVANCE_EM)))
		: 1;
	const wrapped = split ? wrap_output(raw_output, output_columns) : [];
	const max_lines = Math.max(1, Math.floor(BODY_HEIGHT / lineHeight));
	return {
		fontSize,
		lineHeight,
		split,
		output: wrapped,
		maxOutputLines: max_lines,
		maxCodeLines: max_lines,
	};
}

function line_width(line: TokenLine[]): number {
	return line.reduce((total, token) => total + token.text.length, 0);
}

/** Wrap console output to the column, preferring spaces (tabs expand to
 *  four); unbreakable runs fall back to a hard split. */
function wrap_output(lines: string[], columns: number): string[] {
	const wrapped: string[] = [];
	for (const raw of lines) {
		let text = raw.replace(/\t/g, "    ");
		if (text.length === 0) {
			wrapped.push("");
			continue;
		}
		while (text.length > columns) {
			let cut = text.lastIndexOf(" ", columns);
			if (cut <= 0) cut = columns;
			wrapped.push(text.slice(0, cut));
			text = text.slice(cut).replace(/^ /, "");
		}
		wrapped.push(text);
	}
	return wrapped;
}

async function load_font(env: CardEnv, url: URL): Promise<string> {
	const font = font_promise ?? (font_promise = fetch_font(env, url));
	try {
		return await font;
	} catch (error) {
		// Don't cache a failed fetch for the isolate's lifetime.
		font_promise = undefined;
		throw error;
	}
}

async function fetch_font(env: CardEnv, url: URL): Promise<string> {
	if (!env.ASSETS) throw new Error("ASSETS binding is unavailable");
	const response = await env.ASSETS.fetch(new URL(FONT_URL, url));
	if (!response.ok) throw new Error(`font fetch failed: ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength === 0) throw new Error("font asset is empty");
	return base64(bytes);
}

/** Base64 without spreading a whole font into one function call. */
function base64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x4000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

async function highlighted_lines(source: string): Promise<TokenLine[][]> {
	const code = source.replace(/\t/g, "    ");
	try {
		const { tokens } = await codeToTokens(code, { lang: "nomen", theme: "dark-plus" });
		return tokens.map((line) =>
			line.map((token) => ({ text: token.content, color: token.color ?? TOKEN_FALLBACK })),
		);
	} catch {
		return code.split("\n").map((line) => [{ text: line, color: TOKEN_FALLBACK }]);
	}
}

function token_line_html(tokens: TokenLine[]): string {
	if (tokens.every((token) => token.text.length === 0)) {
		return `<div class="line">&#160;</div>`;
	}
	const spans = tokens
		.filter((token) => token.text.length > 0)
		.map((token) => `<span style="color:${token.color}">${escape_html(token.text)}</span>`)
		.join("");
	return `<div class="line">${spans}</div>`;
}

function escape_html(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
