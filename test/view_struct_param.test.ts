import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

const opts = { audit: true, js: true };

// A `view T` parameter is a borrowed SLICE of T elements (a (ptr, len) pair),
// whatever T is — a struct element type included.
describe("view parameters of struct elements", () => {
	test("slices of value and mv structs", async () => {
		const input = `import System
struct P {
	var int n
}
mv struct Holder {
	mv string s
}
func total = (view P ps, out int) {
	var t = 0
	for p of ps {
		t = t + p.n
	}
	return t + ps.length
}
func first = (view Holder hs, out int) {
	return hs.length
}
pub func main = () {
	const arr = [P(1), P(2), P(3)]
	const hs = [Holder("a" + "1"), Holder("b" + "2")]
	Console.write_line("\\{total(arr.slice(0, 2))} \\{first(hs.slice(1, 2))}")
}
`;
		await build_and_check_output(input, "view_struct_param_slices", "5 1", true, opts);
	});

	test("a view is not a single struct", () => {
		const parsed = parse_with_imports(`struct P {
	var int n
}
func get = (view P ps, out int) {
	return ps.n
}
const p = P(1)
const t = get(p)`);
		expect(parsed.errors.map((e) => e.message)).toEqual([
			"'ps' is a view of P elements, not a P --> read an element first ('ps.at(i).n'), or take a plain 'P' parameter",
			"Type mismatch in param: P (expected view P)",
		]);
	});
});
