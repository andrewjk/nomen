import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

const opts = { arch: "aarch64", audit: true } as const;

describe("Console.write_line", () => {
	test("writes a string followed by a newline", async () => {
		const input = `
Console.write_line("hello")
Console.write_line("world")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", platform: "macos", audit: true });
		await check_output("console_write_line", result, "hello\nworld\n", opts);
	});
});

describe("Console.read_char", () => {
	test("reads a single character from stdin", async () => {
		const input = `
const char c = Console.read_char()
Console.write("\\{c}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", platform: "macos", audit: true });
		await check_output("console_read_char", result, "q", {
			arch: "aarch64",
			audit: true,
			provideStdin: "q",
		});
	});
});

describe("Console.read_line", () => {
	test("reads a line from stdin (without the trailing newline)", async () => {
		const input = `
const string line = Console.read_line()
Console.write_line(line)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", platform: "macos", audit: true });
		await check_output("console_read_line", result, "typed text\n", {
			arch: "aarch64",
			audit: true,
			provideStdin: "typed text\nsecond line\n",
		});
	});
});

describe("Console.platform", () => {
	test("returns the current target platform", async () => {
		const input = `
Console.write(Console.platform())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", platform: "macos", audit: true });
		await check_output("console_platform_macos", result, "macos", opts);
	});

	test("honours a different target platform", async () => {
		const input = `
Console.write(Console.platform())
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", platform: "linux", audit: true });
		await check_output("console_platform_linux", result, "linux", opts);
	});
});
