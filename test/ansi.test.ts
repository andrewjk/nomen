import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Ansi helpers wrap text in SGR escape sequences (ESC = 0x1b). The tests check
// the raw byte output, so expected strings use \x1b explicitly.
const opts = { arch: "aarch64", audit: true } as const;

describe("Ansi foreground colors", () => {
	test("red wraps with ESC[31m ... ESC[0m", async () => {
		const input = `
Console.write(Ansi.red("err"))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", platform: "macos", audit: true });
		await check_output("ansi_red", result, "\x1b[31merr\x1b[0m", opts);
	});

	test("green and blue concatenate correctly", async () => {
		const input = `
Console.write(Ansi.green("ok") + Ansi.blue("info"))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", platform: "macos", audit: true });
		await check_output("ansi_green_blue", result, "\x1b[32mok\x1b[0m\x1b[34minfo\x1b[0m", opts);
	});
});

describe("Ansi background colors", () => {
	test("bg_red wraps with ESC[41m", async () => {
		const input = `
Console.write(Ansi.bg_red("ERROR"))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", platform: "macos", audit: true });
		await check_output("ansi_bg_red", result, "\x1b[41mERROR\x1b[0m", opts);
	});
});

describe("Ansi styles", () => {
	test("bold wraps with ESC[1m", async () => {
		const input = `
Console.write(Ansi.bold("title"))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", platform: "macos", audit: true });
		await check_output("ansi_bold", result, "\x1b[1mtitle\x1b[0m", opts);
	});

	test("underline wraps with ESC[4m", async () => {
		const input = `
Console.write(Ansi.underline("link"))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", platform: "macos", audit: true });
		await check_output("ansi_underline", result, "\x1b[4mlink\x1b[0m", opts);
	});
});

describe("Ansi in interpolation", () => {
	test("can be used inline via string interpolation", async () => {
		const input = `
Console.write("\\{Ansi.bg_red("ERROR")}: it didn't work")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", platform: "macos", audit: true });
		await check_output("ansi_interpolate", result, "\x1b[41mERROR\x1b[0m: it didn't work", opts);
	});

	test("can be nested", async () => {
		const input = `
Console.write(Ansi.bold(Ansi.green("success")))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", platform: "macos", audit: true });
		await check_output("ansi_nested", result, "\x1b[1m\x1b[32msuccess\x1b[0m\x1b[0m", opts);
	});
});
