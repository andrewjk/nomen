import { describe, expect, test } from "vite-plus/test";

import { compile_main } from "./_helpers.ts";

describe("readme: standard library — Console", () => {
	test("write, write_line, read_line, read_char, platform", () => {
		const input = `
Console.write("no newline")
Console.write_line("with newline")

const string line = Console.read_line()
const char c = Console.read_char()
const string p = Console.platform()
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("readme: standard library — Ansi", () => {
	test("bg_red, bold, green styling helpers", () => {
		const input = `
Console.write("\\{Ansi.bg_red("ERROR")}: it didn't work")
Console.write_line(Ansi.bold(Ansi.green("success")))
`;
		expect(compile_main(input)).toEqual([]);
	});
});
