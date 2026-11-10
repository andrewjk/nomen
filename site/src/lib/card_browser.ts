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
 * The Fira Code subset is a static asset (SIL OFL, see
 * `src/public/fonts/OFL.txt`). It is embedded as a data URL so the screenshot
 * never races an external font request.
 */

const WIDTH = 1200;
const HEIGHT = 630;
const MAX_OUTPUT_LINES = 8;
/** Card lines that fit below the header at the CSS line height (25px). */
const MAX_LINES = 19;
const FONT_URL = "/fonts/fira-code.woff2";
const TOKEN_FALLBACK = "#d4d4d4";
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
	const output_lines = (output ?? "").replace(/\r\n?/g, "\n").split("\n");
	while (output_lines.length > 0 && output_lines[output_lines.length - 1].trim() === "") {
		output_lines.pop();
	}

	const shown_output = Math.min(output_lines.length, MAX_OUTPUT_LINES);
	const code_limit = Math.max(1, MAX_LINES - (shown_output > 0 ? shown_output + 1 : 0));
	const code_truncated = lines.length > code_limit;
	const shown_code = code_truncated ? code_limit - 1 : lines.length;
	const code_html = lines
		.slice(0, shown_code)
		.map((line) => line_html(line))
		.join("");
	const ellipsis = code_truncated ? `<div class="line muted">...</div>` : "";

	let output_html = "";
	if (shown_output > 0) {
		const shown = output_lines.slice(0, shown_output);
		if (output_lines.length > shown_output) {
			shown[shown.length - 1] = "...";
		}
		output_html = `<div class="rule"></div><div class="output">${shown
			.map((line) => line_html([{ text: line || "\u00a0", color: "#9aa4b2" }]))
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
	padding: 40px 48px;
}
header {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	flex: 0 0 auto;
	padding-bottom: 14px;
	margin-bottom: 18px;
	border-bottom: 1px solid #262d36;
}
h1 {
	margin: 0;
	font-size: 30px;
	line-height: 36px;
	font-weight: 600;
	letter-spacing: -0.5px;
	color: #e6e9ee;
}
h1 span { color: #8ab4f8; }
.host { font-size: 16px; line-height: 36px; color: ${MUTED}; }
.code, .output {
	font-size: 18px;
	line-height: 25px;
	white-space: pre;
	overflow: hidden;
}
.code { flex: 0 0 auto; }
.line { white-space: pre; }
.muted { color: ${MUTED}; }
.rule {
	flex: 0 0 auto;
	border-top: 1px solid #262d36;
	margin: 14px 0 10px;
}
.output { flex: 0 0 auto; color: #9aa4b2; }
</style>
</head>
<body>
<div class="card">
<header><h1>Nomen <span>Playground</span></h1><div class="host">${escape_html(host)}</div></header>
<div class="code">${code_html}${ellipsis}</div>
${output_html}
</div>
</body>
</html>`;
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

function line_html(tokens: TokenLine[]): string {
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
