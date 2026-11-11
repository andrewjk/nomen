import { expect, test } from "vitest";

import { build_card_html, render_code_card } from "./card_browser.ts";

const env = {
	ASSETS: {
		fetch: async () => new Response("font"),
	},
};

const url = new URL("https://nomen.test/s/test/card.png");

test("builds a split Fira Code page with syntax colours and output", async () => {
	const html = await build_card_html(
		env,
		url,
		'pub func main = () {\n\tif 1 < 2 {\n\t\tConsole.write_line("hi")\n\t}\n}',
		"hi\n",
		"nomen.test",
	);
	expect(html).toContain('class="body split"');
	expect(html).toContain("grid-template-columns: 3fr 1fr");
	expect(html).toContain("font-size:18px");
	expect(html).toContain('font-family: "Fira Code"');
	expect(html).toContain("data:font/woff2;base64,");
	expect(html).toContain("Nomen <span>Playground</span>");
	expect(html).toContain("nomen.test");
	expect(html).toContain("Console");
	expect(html).toContain("&lt;");
	expect(html).toContain('<div class="output"');
	expect(html).toContain('<div class="line">hi</div>');
});

test("without output the code takes the full width", async () => {
	const html = await build_card_html(env, url, 'Console.write_line("hi")', undefined, "nomen.test");
	expect(html).not.toContain('class="body split"');
	expect(html).not.toContain('class="output"');
	expect(html).toContain('<div class="body">');
});

test("long programs shrink the font before truncating", async () => {
	const thirty = Array.from({ length: 30 }, (_, i) => `// line ${i}`).join("\n");
	const fit = await build_card_html(env, url, thirty, undefined, "nomen.test");
	expect(fit).toContain("font-size:11px");
	expect(fit).toContain("// line 29");
	expect(fit).not.toContain('<div class="line muted">...</div>');

	const sixty = Array.from({ length: 60 }, (_, i) => `// line ${i}`).join("\n");
	const truncated = await build_card_html(env, url, sixty, undefined, "nomen.test");
	expect(truncated).toContain("font-size:10px");
	expect(truncated).toContain('<div class="line muted">...</div>');
	expect(truncated).not.toContain("// line 59");
});

test("long output is wrapped and truncated to the output column", async () => {
	const output = Array.from({ length: 100 }, (_, i) => `out ${i}`).join("\n");
	const html = await build_card_html(env, url, "// code", output, "nomen.test");
	expect(html).toContain('class="body split"');
	expect(html).toContain('<div class="line">out 0</div>');
	expect(html).toContain('<div class="line">...</div>');
	expect(html).not.toContain("out 99");
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
