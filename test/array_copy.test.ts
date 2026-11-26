import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

// `Array.copy()` on aarch64, C (audit leak-checked) and JS: a new heap array
// with its own storage; string elements get their own bytes.

async function run(name: string, program: string, expected: string): Promise<void> {
	await build_and_check_output(`import System\n${program}`, name, expected, true, {
		js: true,
		audit: true,
	});
}

describe("Array.copy", () => {
	test("int and string copies are independent of the source", async () => {
		await run(
			"array_copy_values",
			`
pub func main = () {
	const Array<int> a = Array.with(3, 4)
	var b = a.copy()
	if b.length > 0 {
		b.set(0, 9)
	}
	Console.write_line("\\{a.at_or(0, 0)} \\{b.at_or(0, 0)} \\{b.length}")
	const Array<string> s = Array.with("a\\x00b", 2)
	var t = s.copy()
	if t.length > 1 {
		t.set(1, "zz")
	}
	Console.write_line("\\{s.at_or(1, "?").length} " + t.at_or(1, "?") + " \\{t.at_or(0, "?").char_code_at_or(1, -1)}")
	const Array<int> e = Array.with(1, 0)
	const empty = e.copy()
	Console.write_line("\\{empty.length}")
}
`,
			"3 9 4\n3 zz 0\n0\n",
		);
	});

	test("a copy can seed or replace an owned field", async () => {
		await run(
			"array_copy_fields",
			`
mv struct Holder {
	var Array<string> names
}

pub func main = () {
	const a = Holder(Array.with("x", 2))
	var b = Holder(a.names.copy())
	b.names = a.names.copy()
	const Array<string> loose = a.names.copy()
	Console.write_line("\\{b.names.length} \\{loose.length} " + b.names.at_or(1, "?"))
}
`,
			"2 2 x\n",
		);
	});

	test("a struct's synthesized copy copies its Array<T> fields", async () => {
		await run(
			"array_copy_struct_copy",
			`
mv struct Roster {
	var Array<string> names
	var Array<int> scores = Array.with(1, 2)
	mv string label = "r"
}

pub func main = () {
	const a = Roster(Array.with("x", 2))
	var b = a.copy()
	if b.names.length > 0 {
		b.names.set(0, "y")
	}
	if b.scores.length > 0 {
		b.scores.set(0, 7)
	}
	Console.write_line(a.names.at_or(0, "?") + b.names.at_or(0, "?") + " \\{a.scores.at_or(0, 0)} \\{b.scores.at_or(0, 0)} \\{b.scores.length} " + b.label)
}
`,
			"xy 1 7 2 r\n",
		);
	});

	test("struct elements copy through their own copy()", async () => {
		await run(
			"array_copy_structs",
			`
mv struct Tag {
	mv string s
	var int n
}

pub func main = () {
	const Array<Tag> tags = [Tag("a".to_string(), 1), Tag("b".to_string(), 2)]
	var c = tags.copy()
	if c.length > 1 {
		c.set(0, Tag("z".to_string(), 9))
		Console.write_line(tags.at(0).s + c.at(0).s + c.at(1).s + " \\{c.at(1).n} \\{c.length}")
	}
}
`,
			"azb 2 2\n",
		);
	});

	test("nested arrays copy every row", async () => {
		await run(
			"array_copy_nested",
			`
mv struct Rec {
	mv string name
}

pub func main = () {
	const g = [[1, 2], [3, 4]]
	var h = g.copy()
	if h.length > 1 {
		var row = h.at(1)
		if row.length > 0 {
			row.set(0, 5)
		}
		Console.write_line("\\{g.at(1).at(0)} \\{h.at(1).at(0)} \\{h.at(0).at(1)} \\{h.length}")
	}
	const w = [["ab", "cd"], ["ef"]]
	const v = w.copy()
	if v.length > 1 {
		Console.write_line(v.at(1).at(0) + v.at(0).at(1) + " \\{v.at(0).length}")
	}
	const t = [[[1, 2], [3]], [[4]]]
	const u = t.copy()
	if u.length > 1 {
		Console.write_line("\\{u.at(0).length} \\{u.at(1).length}")
	}
	const r = [[Rec("a"), Rec("b")], [Rec("c")]]
	const q = r.copy()
	if q.length > 1 {
		Console.write_line(q.at(0).at(1).name + q.at(1).at(0).name)
	}
}
`,
			"3 5 2 2\nefcd 2\n2 1\nbc\n",
		);
	});

	test("elements with no copy story are rejected", () => {
		const system = get_library(path.resolve("core"));
		const errors = parse(
			`import System
pub func main = () {
	const nodes = [Box<int>(3)]
	const c = nodes.copy()
	Console.write_line("\\{c.length}")
}
`,
			system,
			undefined,
			{ allow_internal: true },
		).errors.map((e) => e.message);
		expect(
			errors.filter((e) => e.startsWith("copy() would share the elements' heap memory")),
		).toHaveLength(1);
	});

	test("a struct's copy deep-copies nested array fields", async () => {
		await run(
			"array_copy_struct_deep_fields",
			`
mv struct Board {
	var Array<Array<int>> rows
	var Array<Array<string>> names
}

pub func main = () {
	const a = Board([[1, 2], [3]], [["n"]])
	const b = a.copy()
	if b.rows.length > 1 {
		if b.names.length > 0 {
			Console.write_line("\\{b.rows.at(0).at(1)} \\{b.rows.at(1).length} " + b.names.at(0).at(0))
		}
	}
}
`,
			"2 1 n\n",
		);
	});
});
