import { codeToTokens } from "nomen-shiki";
import { ImageResponse, loadGoogleFont } from "workers-og";

/**
 * Renders the per-program social card for a share link: the actual code, on
 * the site's dark editor background, with Shiki's theme colors.
 *
 * Runs in the Worker via `workers-og` (Satori + resvg WASM), so the image is
 * derived from the URL's bytes and needs no headless browser or storage.
 *
 * The element tree is built directly instead of as an HTML string: the HTML
 * path passes text through `HTMLRewriter` without decoding entities, so
 * escaped text would render literally (`&quot;`) and a raw `<` would be
 * parsed as markup.
 */

const WIDTH = 1200;
const HEIGHT = 630;
const MAX_LINES = 14;
const MAX_COLS = 88;

const TEXT = "#d4d4d4";
const MUTED = "#9aa4b2";
const ACCENT = "#8ab4f8";

type Style = Record<string, string | number>;

interface Element {
	type: string;
	props: { style?: Style; children?: Array<Element | string> };
}

let font_promise: Promise<ArrayBuffer> | undefined;

function mono_font(): Promise<ArrayBuffer> {
	const font =
		font_promise ??
		loadGoogleFont({ family: "JetBrains Mono", weight: 400 }).catch((error: unknown) => {
			// Don't cache a failed fetch for the isolate's lifetime.
			font_promise = undefined;
			throw error;
		});
	font_promise = font;
	return font;
}

function div(style: Style, children: Array<Element | string>): Element {
	return { type: "div", props: { style, children } };
}

function truncate(lines: string[]): string[] {
	let out = lines;
	if (out.length > MAX_LINES) out = [...out.slice(0, MAX_LINES - 1), "…"];
	return out.map((line) => (line.length > MAX_COLS ? `${line.slice(0, MAX_COLS - 1)}…` : line));
}

/** One rendered line: a span per token, using the theme's colors. */
async function highlighted_lines(code: string): Promise<Element[]> {
	try {
		const { tokens } = await codeToTokens(code, { lang: "nomen", theme: "dark-plus" });
		return tokens.map((line) => {
			const spans = line.flatMap((token) =>
				token.content
					? [
							{
								type: "span",
								props: { style: { color: token.color ?? TEXT }, children: [token.content] },
							} as Element,
						]
					: [],
			);
			return div({ display: "flex", whiteSpace: "pre" }, spans.length ? spans : [" "]);
		});
	} catch {
		return code
			.split("\n")
			.map((line) => div({ display: "flex", whiteSpace: "pre" }, [line || " "]));
	}
}

export async function render_code_card(source: string, host: string): Promise<ArrayBuffer> {
	const font = await mono_font();
	const code = truncate(source.replace(/\t/g, "    ").split("\n")).join("\n");
	const lines = await highlighted_lines(code);

	const tree = div(
		{
			display: "flex",
			flexDirection: "column",
			width: WIDTH,
			height: HEIGHT,
			backgroundColor: "#101214",
			padding: 48,
			fontFamily: "JetBrains Mono",
			color: TEXT,
		},
		[
			div(
				{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					marginBottom: 26,
				},
				[
					div({ display: "flex", fontSize: 34, color: "#e6e9ee", letterSpacing: "-0.5px" }, [
						"Nomen",
						{
							type: "span",
							props: {
								style: { color: ACCENT, marginLeft: 10 },
								children: ["REPL"],
							},
						},
					]),
					div({ display: "flex", fontSize: 18, color: MUTED }, [host]),
				],
			),
			div(
				{
					display: "flex",
					flexDirection: "column",
					flexGrow: 1,
					backgroundColor: "#171a1f",
					border: "1px solid #2a313a",
					borderRadius: 14,
					padding: "24px 26px",
					overflow: "hidden",
					fontSize: 18,
					lineHeight: 1.4,
					color: TEXT,
				},
				lines,
			),
			div({ display: "flex", marginTop: 18, fontSize: 16, color: MUTED }, [
				"Compiled and run in your browser",
			]),
		],
	);

	const image = new ImageResponse(tree as unknown as Parameters<typeof ImageResponse>[0], {
		width: WIDTH,
		height: HEIGHT,
		fonts: [{ name: "JetBrains Mono", data: font, weight: 400, style: "normal" }],
	});
	// Read the body here so a rendering error is catchable by the route (the
	// Response streams, and failures would otherwise surface mid-response).
	return image.arrayBuffer();
}
