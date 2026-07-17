import { describe, expect, test } from "vite-plus/test";

import { compile_main } from "./_helpers.ts";

describe("spec: console", () => {
	test("Console write and write_line", () => {
		const input = `
Console.write("no newline")
Console.write_line("with newline")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("Console read functions and platform", () => {
		const input = `
const string line = Console.read_line()
const char c = Console.read_char()
const string p = Console.platform()
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("spec: ansi", () => {
	test("Ansi styling helpers", () => {
		const input = `
Console.write("\\{Ansi.bg_red("ERROR")}: it didn't work")
Console.write_line(Ansi.bold(Ansi.green("success")))
`;
		expect(compile_main(input)).toEqual([]);
	});
});
