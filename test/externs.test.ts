import path from "node:path";

import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// `extern func` declarations map a body-less Nomen function onto a C
// library symbol. The core library uses them for atoi (Init.parse_int) and
// strdup (String.to_string); these tests exercise the extern path end to
// end on both backends.

const core = get_library(path.resolve(import.meta.dirname, "../core"));

describe("extern functions", () => {
	test("library extern callable from user code (string param, int return)", async () => {
		const input = `import System
pub func main = () {
	const string digits = "41"
	Console.write("\\{parse_int(digits) + 1}")
}
`;
		const parsed = parse(input, core);
		expect(parsed.errors).toEqual([]);
		expect(parsed.errors).toEqual([]);
		const expected = "42";
		for (const arch of ["aarch64", "c"] as const) {
			const result = build(parsed.root, { arch, audit: true });
			expect(result.errors ?? []).toEqual([]);
			await check_output(`extern_atoi_${arch}`, result, expected, { arch, audit: true });
		}
	});

	test("extern returning a string re-wraps the fat pair (strdup via to_string)", async () => {
		const input = `
const string original = "owned copy"
const string copy = original.to_string()
Console.write(copy)
Console.write("\\{copy.length}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const expected = "owned copy10";
		for (const arch of ["aarch64", "c"] as const) {
			const result = build(parsed.root, { arch, audit: true });
			expect(result.errors ?? []).toEqual([]);
			await check_output(`extern_strdup_${arch}`, result, expected, { arch, audit: true });
		}
	});

	test("method externs marshal sole float params (Math.sqrt/log)", async () => {
		const input = `
const float r = Math.sqrt(4.0)
const float l = Math.log(1.0)
Console.write("\\{r}")
Console.write("\\n")
Console.write("\\{l}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const expected = "2.000000\n0.000000";
		for (const arch of ["aarch64", "c"] as const) {
			const result = build(parsed.root, { arch, audit: true });
			expect(result.errors ?? []).toEqual([]);
			await check_output(`extern_sqrt_log_${arch}`, result, expected, { arch, audit: true });
		}
	});

	test("extern outside the System library is rejected", () => {
		const input = `import System
extern func getenv_shim = (string name, out int)
pub func main = () {}
`;
		const parsed = parse(input, core);
		expect(
			parsed.errors.some((e) =>
				e.message.includes(`'extern' functions can only be declared in the System library`),
			),
		).toBe(true);
	});
});
