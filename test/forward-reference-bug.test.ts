import path from "node:path";

import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import check_output from "./check_output";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

// Regression test for the forward-reference bug.
//
// A struct's method return type is declared with `out`. Previously,
// check_block_node checked statements in source order, so a struct defined
// textually AFTER a function that calls it (which is always the case for
// library structs, since library source is appended after user code) had its
// methods checked after the caller -- leaving the return type unknown and
// producing "unknown value ..." errors.
//
// The fix: check type definitions (struct/trait/enum/bitset) before functions
// in each block, so method return types are resolved before any caller is
// checked. Both orderings below now compile and run identically.

describe("forward references", () => {
	const MAIN = `
pub func main = () {
    var Thing t = Thing()
    var int x = t.make(7)
    Console.write("\\{x}\\n")
}
`;
	const STRUCT = `
struct Thing {
    var int n = 0
    func make = (ref self, int v, out int) {
        self.n = v
        return self.n
    }
}
`;

	test("struct defined before use compiles and runs", async () => {
		const parsed = parse(`import System\n${STRUCT}${MAIN}`, system);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("forward_ref_before", result, "7\n", { arch: "aarch64", audit: true });
	});

	test("struct defined after use (forward reference) compiles and runs", async () => {
		const parsed = parse(`import System\n${MAIN}${STRUCT}`, system);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("forward_ref_after", result, "7\n", { arch: "aarch64", audit: true });
	});
});
