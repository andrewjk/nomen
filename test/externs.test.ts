import path from "node:path";

import { expect, describe, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

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
		const expected = "42";
		await build_and_check_output(input, "extern_atoi", expected, true);
	});

	test("extern returning a string re-wraps the fat pair (strdup via to_string)", async () => {
		const input = `
const string original = "owned copy"
const string copy = original.to_string()
Console.write(copy)
Console.write("\\{copy.length}")
`;
		const expected = "owned copy10";
		await build_and_check_output(input, "extern_strdup", expected);
	});

	test("method externs marshal sole float params (Math.sqrt/log)", async () => {
		const input = `
const float r = Math.sqrt(4.0)
const float l = Math.log(1.0)
Console.write("\\{r}")
Console.write("\\n")
Console.write("\\{l}")
`;
		const expected = "2.000000\n0.000000";
		await build_and_check_output(input, "extern_sqrt_log", expected);
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
