import { expect, test } from "vitest";

import { render_code_card } from "./card.ts";

function png_size(png: Uint8Array): { width: number; height: number } {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

test("renders a 1200x630 indexed PNG with the program", async () => {
	const png = new Uint8Array(
		await render_code_card('Console.write_line("hello")', undefined, "nomen.test"),
	);
	expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	expect(png[25]).toBe(3); // colour type 3: indexed
	expect(png_size(png)).toEqual({ width: 1200, height: 630 });
	expect(png.length).toBeGreaterThan(500);
});

test("the shared run output changes the card", async () => {
	const source = 'Console.write_line("hello")';
	const bare = new Uint8Array(await render_code_card(source, undefined, "nomen.test"));
	const with_output = new Uint8Array(await render_code_card(source, "hello\n", "nomen.test"));
	expect(with_output.length).not.toBe(bare.length);
	expect(png_size(with_output)).toEqual({ width: 1200, height: 630 });
});

test("non-ASCII and long lines degrade instead of failing", async () => {
	const png = new Uint8Array(
		await render_code_card(
			`Console.write_line("héllo 🚀 ${"x".repeat(200)}")\n${"line\n".repeat(40)}`,
			`out 🚀 ${"y".repeat(200)}\n${"more\n".repeat(20)}`,
			"nomen.test",
		),
	);
	expect(png_size(png)).toEqual({ width: 1200, height: 630 });
});
