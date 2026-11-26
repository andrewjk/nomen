import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// `for x of v` over a `view T`: an index loop over the view's `.length` /
// `.at` (check_for_loop_node), for named views, inline slices and `view`
// params.
describe("for ... of over a view", () => {
	test("iterates the view's elements", async () => {
		const input = `import System
mv struct Rec {
	mv string name
}
func total = (view int v, out int) {
	var n = 0
	for x of v {
		n = n + x
	}
	return n
}
pub func main = () {
	const g = [1, 2, 3, 4]
	view v = g.slice(1, 3)
	var n = 0
	for x of v {
		n = n + x
	}
	for x of g.slice(2, 4) {
		n = n + x
	}
	for x of g.slice(0, 0) {
		n = n + 100
	}
	const w = ["a", "b", "c"]
	const r = [Rec("x"), Rec("y")]
	view vr = r.slice(0, 2)
	var o = ""
	for s of w.slice(1, 3) {
		o = o + s
	}
	for q of vr {
		o = o + q.name
	}
	const t = "hello"
	view h = t.slice(1, 4)
	for c of h {
		o = o + "\\{c}"
	}
	const nested = [[1, 2], [3], [4, 5, 6]]
	var m = 0
	for row of nested.slice(1, 3) {
		m = m + row.length
		for x of row {
			m = m + x
		}
	}
	Console.write_line("\\{n} \\{total(g.slice(1, 4))} " + o + " \\{m}")
}
`;
		await build_and_check_output(input, "view_for_of", "12 9 bcxyell 22", true, {
			audit: true,
			js: true,
		});
	});

	test("a string array's view holds strings", async () => {
		const input = `import System
pub func main = () {
	const w = ["ab", "cd", "ef"]
	view vw = w.slice(1, 3)
	Console.write_line(vw.at(1) + "\\{vw.length}")
}
`;
		await build_and_check_output(input, "view_string_array", "ef2", true, {
			audit: true,
			js: true,
		});
	});

	test("ref iteration over a view is rejected", () => {
		const parsed = parse_with_imports(`const g = [1, 2, 3]
view v = g.slice(0, 2)
for ref x of v {
}`);
		expect(parsed.errors.map((e) => e.message)).toContain(
			"'ref' iteration is not supported for a view — views are read-only",
		);
	});
});
