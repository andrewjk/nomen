import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

const ARCHS = ["aarch64", "c"] as const;

// Run a container geometry snippet on both backends and assert the printed
// frames match. The `compute` / `fmt_frame` path is pure math (no native
// rendering), so both backends must agree — this catches regressions that
// would otherwise only surface on one backend (e.g. the module-level const
// text-relocation bug that went unnoticed because these tests were c-only).
async function run(name: string, input: string, expected: string) {
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	for (const arch of ARCHS) {
		const result = build(parsed.root, { arch, platform: "macos" });
		await check_output(`${name}_${arch}`, result, expected, { arch, audit: false });
	}
}

describe("container layout", () => {
	test("vstack stacks children vertically, full width", async () => {
		await run(
			"container_vstack",
			`
var Container v = VStack(10)
v.add(0, 0, 30, 1)
v.add(0, 0, 40, 1)
v.compute(800, 600)
Console.write(v.fmt_frame(1) + " " + v.fmt_frame(2) + "\\n")
`,
			"0,0,800,30 0,40,800,40\n",
		);
	});

	test("hstack stacks children horizontally", async () => {
		await run(
			"container_hstack",
			`
var Container h = HStack(0)
h.add(0, 30, 50, 1)
h.add(0, 60, 80, 1)
h.compute(800, 600)
Console.write(h.fmt_frame(1) + " " + h.fmt_frame(2) + "\\n")
`,
			"0,0,30,80 30,0,60,80\n",
		);
	});

	test("grid: span-2 children take full-width rows", async () => {
		await run(
			"container_grid_span",
			`
var Container g = Grid(2, 8)
g.add(0, 0, 30, 2)
g.add(0, 0, 24, 2)
g.compute(400, 500)
Console.write(g.fmt_frame(1) + " " + g.fmt_frame(2) + "\\n")
`,
			"0,0,400,30 0,38,400,24\n",
		);
	});

	test("grid: span-1 children share a row across columns", async () => {
		await run(
			"container_grid_row",
			`
var Container g = Grid(2, 0)
g.add(0, 40, 25, 1)
g.add(0, 60, 35, 1)
g.compute(400, 500)
Console.write(g.fmt_frame(1) + " " + g.fmt_frame(2) + "\\n")
`,
			"0,0,200,25 200,0,200,35\n",
		);
	});

	test("grid: mixed spans lay out like the todo app", async () => {
		await run(
			"container_grid_mixed",
			`
var Container g = Grid(2, 8)
g.add(0, 0, 30, 2)
g.add(0, 0, 24, 2)
g.add(0, 0, 24, 2)
g.add(0, 0, 24, 1)
g.add(0, 0, 32, 1)
g.compute(400, 500)
Console.write(g.fmt_frame(1) + " " + g.fmt_frame(2) + " " + g.fmt_frame(3) + " " + g.fmt_frame(4) + " " + g.fmt_frame(5) + "\\n")
`,
			"0,0,400,30 0,38,400,24 0,70,400,24 0,102,200,24 200,102,200,32\n",
		);
	});

	test("zstack overlaps children, sizing to the largest", async () => {
		await run(
			"container_zstack",
			`
var Container z = ZStack()
z.add(0, 100, 50, 1)
z.add(0, 200, 80, 1)
z.compute(800, 600)
Console.write(z.fmt_frame(1) + " " + z.fmt_frame(2) + "\\n")
`,
			"0,0,200,80 0,0,200,80\n",
		);
	});

	test("nested hstack inside vstack arranges its children", async () => {
		await run(
			"container_nested_hstack",
			`
var Container v = VStack(8)
var int row = v.add_hstack(v.root_index(), 12, 1)
v.add_to(row, 0, 50, 30, 1)
v.add_to(row, 0, 60, 30, 1)
v.add(0, 0, 40, 1)
v.compute(800, 600)
Console.write(v.fmt_frame(1) + " " + v.fmt_frame(2) + " " + v.fmt_frame(3) + " " + v.fmt_frame(4) + "\\n")
`,
			"0,0,800,30 0,0,50,30 62,0,60,30 0,38,800,40\n",
		);
	});

	test("nested vstack inside a grid cell stacks within the cell", async () => {
		await run(
			"container_nested_vstack_in_grid",
			`
var Container g = Grid(2, 8)
var int cell = g.add_vstack(g.root_index(), 4, 1)
g.add_to(cell, 0, 0, 20, 1)
g.add_to(cell, 0, 0, 30, 1)
g.add(0, 0, 50, 1)
g.compute(400, 500)
Console.write(g.fmt_frame(1) + " " + g.fmt_frame(2) + " " + g.fmt_frame(3) + " " + g.fmt_frame(4) + "\\n")
`,
			"0,0,200,54 0,0,200,20 0,24,200,30 200,0,200,50\n",
		);
	});
});
