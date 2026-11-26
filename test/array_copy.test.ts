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

	test("elements that own heap memory are rejected", () => {
		const system = get_library(path.resolve("core"));
		const errors = parse(
			`import System
mv struct Box2 {
	mv string s
}

pub func main = () {
	const Array<Array<int>> grid = [[1, 2], [3, 4]]
	const g = grid.copy()
	const Array<Box2> boxes = [Box2("a".to_string())]
	const b = boxes.copy()
	Console.write_line("\\{g.length} \\{b.length}")
}
`,
			system,
			undefined,
			{ allow_internal: true },
		).errors.map((e) => e.message);
		expect(
			errors.filter((e) => e.startsWith("copy() would share the elements' heap memory")),
		).toHaveLength(2);
	});

	test("a struct with a heap-owning Array<T> field gets no copy", () => {
		const system = get_library(path.resolve("core"));
		const errors = parse(
			`import System
mv struct Grid {
	var Array<Array<int>> rows
}

pub func main = () {
	const g = Grid([[1, 2], [3]])
	const h = g.copy()
	Console.write_line("\\{h.rows.length}")
}
`,
			system,
			undefined,
			{ allow_internal: true },
		).errors.map((e) => e.message);
		expect(errors.some((e) => e.includes("Grid.copy"))).toBe(true);
	});
});
