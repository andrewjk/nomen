import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

const opts = { audit: true, js: true };

// Binding an existing heap `Array<T>` to a new name creates a new owner, so
// it is spelled: `mv q` transfers the buffer, `q.copy()` duplicates it.
describe("heap array bindings", () => {
	test("mv and copy bindings", async () => {
		const input = `import System
pub func main = () {
	var Array<int> q = [7, 8]
	var c = q.copy()
	if c.length > 0 {
		c.set(0, 1)
	}
	const w = mv q
	var Array<int>? nq = null
	const n0 = nq?.copy()
	nq = [3]
	const n1 = nq?.copy()
	Console.write_line("\\{c.at_or(0, 0)} \\{w.at_or(0, 0)} \\{w.length} \\{n0 == null} \\{n1?.length ?? -1}")
}
`;
		await build_and_check_output(input, "array_binding_mv_copy", "1 7 2 true 1", true, opts);
	});

	test("mv bindings of owning and nested arrays", async () => {
		const input = `import System
pub func main = () {
	var Array<string> ss = ["a" + "1", "b" + "2"]
	const ts = mv ss
	var Array<Array<int>> g = [[1, 2], [3, 4, 5]]
	const h = mv g
	Console.write_line(ts.at_or(1, "-") + " \\{h.length}")
}
`;
		await build_and_check_output(input, "array_binding_mv_owning", "b2 2", true, opts);
	});

	test("a bare binding would share the buffer", () => {
		const parsed = parse_with_imports(`var Array<int> q = [7, 8]
const w = q
var Array<int>? nq = null
var v = nq`);
		expect(parsed.errors.map((e) => e.message)).toEqual([
			"Binding 'q' to 'w' would share its buffer --> transfer it with `mv q`, or bind a copy (`q.copy()`)",
			"Binding 'nq' to 'v' would share its buffer --> transfer it with `mv nq`, or bind a copy (`nq?.copy()`)",
		]);
	});
});

// A heap `Array<string>` literal owns its rows: computed elements transfer
// (a fresh result, or the `mv` of a heap string) or are dup'd (an `mv` of a
// folded literal).
describe("computed string elements", () => {
	test("fresh, moved and literal rows", async () => {
		const input = `import System
pub func main = () {
	var a = "q"
	a = a + "z"
	const t = a + "r"
	const f = "x" + "y"
	var Array<string> ss = ["a" + "1", mv t, mv f, "lit"]
	Console.write_line(ss.at_or(0, "-") + ss.at_or(1, "-") + ss.at_or(2, "-") + ss.at_or(3, "-"))
}
`;
		await build_and_check_output(input, "array_string_computed_rows", "a1qzrxylit", true, opts);
	});
});
