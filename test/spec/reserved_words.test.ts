import { describe, expect, test } from "vite-plus/test";

import parse from "../../src/parse.ts";
import test_error from "../test_error.ts";
import { compile_main, core } from "./_helpers.ts";

describe("spec: reserved words", () => {
	test("reserved word as variable name is an error", () => {
		const input = `import System

pub func main = () {
	var out = StringBuilder()
}
`;
		expect(parse(input, core).errors).toEqual([
			test_error(input, "'out' is a reserved word and cannot be used as a name", 4, 6),
		]);
	});

	test("keyword method names are callable", () => {
		const input = `
const string m = Regex.match("[0-9]+", "abc123")
Console.write("\\{m}")
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("class is retired with a dedicated error", () => {
		const input = `
class Box { var int value }
`;
		const parsed = parse(input, core);
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"'class' has retired — declare `mv struct` (single-owner, move-only) and spell sharing where it happens (`ref`, `Box<T>`, `Mutex<T>`, `WeakHandle<T>`)",
				2,
				1,
			),
		]);
	});
});
