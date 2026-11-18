import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// The Enumerable conformers (LinkedList/Tree/Graph) were CHECK-ADMITTED by
// `for x of <value>` and then broke per backend: the C backend crashed
// (build_node on the missing compile-time length node — `length` is a
// method on these containers), and the aarch64 binary silently iterated
// ZERO times. The checker now rejects them with the same clarity as the
// non-Enumerable gate until return-contract linkage from `length()` to the
// count field lands (FOLLOWUP.md, "Element iteration for remaining
// collections").

function expect_rejected(src: string, fragment: string): void {
	const parsed = parse_with_imports(src);
	const messages = parsed.errors.map((e) => e.message).join("\n");
	expect(messages).toContain(fragment);
}

test("for-of over LinkedList is cleanly rejected", () => {
	expect_rejected(
		`
var ll = LinkedList<int>()
ll.add(11)
for x of ll {
	Console.write_line(x.to_string())
}
`,
		"'for x of' over LinkedList is not supported yet",
	);
});

test("for-of over Tree is cleanly rejected", () => {
	expect_rejected(
		`
var t = Tree<int>()
t.add(11)
for x of t {
	Console.write_line(x.to_string())
}
`,
		"'for x of' over Tree is not supported yet",
	);
});

test("for-of over Graph is cleanly rejected", () => {
	expect_rejected(
		`
var g = Graph<int>()
g.add_node(11)
for x of g {
	Console.write_line(x.to_string())
}
`,
		"'for x of' over Graph is not supported yet",
	);
});

test("Set/Map keep the must-be-array-List-or-Enumerable rejection", () => {
	expect_rejected(
		`
var s = Set<int>()
s.add(1)
for x of s {
	Console.write_line(x.to_string())
}
`,
		"For loop list must be an array, List, or Enumerable, not Set",
	);
});

test("working shapes stay admitted (array, range, List, StableList)", () => {
	const parsed = parse_with_imports(`
var arr = [1, 2, 3]
for x of arr {
	Console.write_line(x.to_string())
}
for i of 0..2 {
	Console.write_line(i.to_string())
}
var xs = List<int>()
xs.push(1)
for x of xs {
	Console.write_line(x.to_string())
}
var ss = StableList<int>()
ss.push(1)
for x of ss {
	Console.write_line(x.to_string())
}
`);
	expect(parsed.errors).toEqual([]);
});

test("for-of over the count containers still runs (both backends)", async () => {
	await build_and_check_output(
		`
import System
pub func main = (Init init) {
	var arr = [3, 4]
	for x of arr {
		Console.write_line(x.to_string())
	}
	var xs = List<int>()
	xs.push(1)
	xs.push(2)
	for x of xs {
		Console.write_line(x.to_string())
	}
}
`,
		"forof_admitted_shapes",
		"3\n4\n1\n2\n",
		true,
	);
});
