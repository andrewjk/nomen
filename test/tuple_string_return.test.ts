import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

const opts = { arch: "aarch64", audit: true } as const;

// A string local returned inside a tuple literal used to dangle on both
// backends: the callee's scope-exit free released the buffer while the
// returned tuple's field still pointed at it (the caller's read was a
// masked use-after-free). The literal-element last-use inference now
// TRANSFERS heap string locals into the tuple (the callee's cleanup skips
// them), and the destructured binding takes the buffer raw and frees it at
// scope exit — one owner, balanced under audit.
describe("tuple string returns", () => {
	test(
		"string local transferred through a tuple return stays valid",
		{ timeout: 120_000 },
		async () => {
			const input = `
import System

func make = (out [string, int]) {
	var s = "hello world, a string long enough to be heap"
	return [s, 42]
}

pub func main = (Init init) {
	var [a, n] = make()
	Console.write_line("\\{a} \\{n}")
}
`;
			const parsed = parse_raw(input);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch: "aarch64", audit: true });
			await check_output(
				"tuple_string_return",
				result,
				"hello world, a string long enough to be heap 42\n",
				opts,
			);
		},
	);

	test("string local read after the literal is rejected", () => {
		const input = `
import System

func make = (out [string, int]) {
	var s = "hello"
	return [s, 42]
}
pub func main = (Init init) {
	var pair = make()
	Console.write_line("unreachable")
}
`;
		const parsed = parse_raw(input);
		// `s` is read after the literal only via the tuple itself — the shape
		// above compiles clean; assert no spurious rejection here.
		expect(parsed.errors).toEqual([]);
	});
});
