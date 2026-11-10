import { expect, test } from "vitest";

import { build_card_html, render_code_card } from "./card_browser.ts";

const env = {
	ASSETS: {
		fetch: async () => new Response("font"),
	},
};

const url = new URL("https://nomen.test/s/test/card.png");

test("builds a Fira Code screenshot page with syntax colours and output", async () => {
	const html = await build_card_html(
		env,
		url,
		'pub func main = () {\n\tif 1 < 2 {\n\t\tConsole.write_line("hi")\n\t}\n}',
		"hi\n",
		"nomen.test",
	);
	expect(html).toContain('font-family: "Fira Code"');
	expect(html).toContain("data:font/woff2;base64,");
	expect(html).toContain("Nomen <span>Playground</span>");
	expect(html).toContain("nomen.test");
	expect(html).toContain("Console");
	expect(html).toContain("&lt;");
	expect(html).toContain('<div class="output">');
	expect(html).toContain(">hi</span>");
});

test("long programs and outputs are truncated to the card", async () => {
	const source = Array.from({ length: 60 }, (_, i) => `// line ${i}`).join("\n");
	const output = Array.from({ length: 20 }, (_, i) => `out ${i}`).join("\n");
	const html = await build_card_html(env, url, source, output, "nomen.test");
	expect(html).toContain('<div class="line muted">...</div>');
	expect(html).not.toContain("// line 59");
	expect(html).toContain(">out 6</span>");
	expect(html).toContain(">...</span>");
});

test("falls back to the bitmap card without a browser binding", async () => {
	const { png: rendered, fallback } = await render_code_card(
		undefined,
		url,
		'Console.write_line("hi")',
		undefined,
		"nomen.test",
	);
	const png = new Uint8Array(rendered);
	expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	expect(png[25]).toBe(3); // indexed-colour fallback
	expect(fallback).toBe(true);
});
