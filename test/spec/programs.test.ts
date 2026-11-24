import { describe, expect, test } from "vite-plus/test";

import { compile_module } from "./_helpers.ts";

// SPEC.md, "Programs" and "Testing" — one test per fenced code block.

describe("spec: programs", () => {
	test("main takes no parameters or a single Init", () => {
		const input = `
pub func main = (Init init) {
    Console.write_line("\\\\{init.argc} arguments")
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("spec: testing", () => {
	test("a test is a pub func taking a ref Tester", () => {
		const input = `
import System::Test

func add = (int a, int b, out int) => a + b

pub func test_add = (ref Tester t) {
    t.expect(add(1, 1) == 2, "1 + 1 should be 2")
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
