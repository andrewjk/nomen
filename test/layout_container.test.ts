import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

const opts = { arch: "c", audit: false } as const;

describe("container layout", () => {
	test("vstack stacks children vertically, full width", async () => {
		const input = `
var Container v = VStack(10)
v.add(0, 0, 30, 1)
v.add(0, 0, 40, 1)
v.compute(800, 600)
Console.write(v.fmt_frame(1) + " " + v.fmt_frame(2) + "\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", platform: "macos" });
		await check_output("container_vstack", result, "0,0,800,30 0,40,800,40\n", opts);
	});

	test("hstack stacks children horizontally", async () => {
		const input = `
var Container h = HStack(0)
h.add(0, 30, 50, 1)
h.add(0, 60, 80, 1)
h.compute(800, 600)
Console.write(h.fmt_frame(1) + " " + h.fmt_frame(2) + "\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", platform: "macos" });
		await check_output("container_hstack", result, "0,0,30,80 30,0,60,80\n", opts);
	});

	test("grid: span-2 children take full-width rows", async () => {
		const input = `
var Container g = Grid(2, 8)
g.add(0, 0, 30, 2)
g.add(0, 0, 24, 2)
g.compute(400, 500)
Console.write(g.fmt_frame(1) + " " + g.fmt_frame(2) + "\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", platform: "macos" });
		await check_output("container_grid_span", result, "0,0,400,30 0,38,400,24\n", opts);
	});

	test("grid: span-1 children share a row across columns", async () => {
		const input = `
var Container g = Grid(2, 0)
g.add(0, 40, 25, 1)
g.add(0, 60, 35, 1)
g.compute(400, 500)
Console.write(g.fmt_frame(1) + " " + g.fmt_frame(2) + "\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", platform: "macos" });
		await check_output("container_grid_row", result, "0,0,200,25 200,0,200,35\n", opts);
	});

	test("grid: mixed spans lay out like the todo app", async () => {
		const input = `
var Container g = Grid(2, 8)
g.add(0, 0, 30, 2)
g.add(0, 0, 24, 2)
g.add(0, 0, 24, 2)
g.add(0, 0, 24, 1)
g.add(0, 0, 32, 1)
g.compute(400, 500)
Console.write(g.fmt_frame(1) + " " + g.fmt_frame(2) + " " + g.fmt_frame(3) + " " + g.fmt_frame(4) + " " + g.fmt_frame(5) + "\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", platform: "macos" });
		await check_output(
			"container_grid_mixed",
			result,
			"0,0,400,30 0,38,400,24 0,70,400,24 0,102,200,24 200,102,200,32\n",
			opts,
		);
	});

	test("zstack overlaps children, sizing to the largest", async () => {
		const input = `
var Container z = ZStack()
z.add(0, 100, 50, 1)
z.add(0, 200, 80, 1)
z.compute(800, 600)
Console.write(z.fmt_frame(1) + " " + z.fmt_frame(2) + "\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", platform: "macos" });
		await check_output("container_zstack", result, "0,0,200,80 0,0,200,80\n", opts);
	});

	test("nested hstack inside vstack arranges its children", async () => {
		const input = `
var Container v = VStack(8)
var int row = v.add_hstack(v.root_index(), 12, 1)
v.add_to(row, 0, 50, 30, 1)
v.add_to(row, 0, 60, 30, 1)
v.add(0, 0, 40, 1)
v.compute(800, 600)
Console.write(v.fmt_frame(1) + " " + v.fmt_frame(2) + " " + v.fmt_frame(3) + " " + v.fmt_frame(4) + "\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", platform: "macos" });
		await check_output(
			"container_nested_hstack",
			result,
			"0,0,800,30 0,0,50,30 62,0,60,30 0,38,800,40\n",
			opts,
		);
	});

	test("nested vstack inside a grid cell stacks within the cell", async () => {
		const input = `
var Container g = Grid(2, 8)
var int cell = g.add_vstack(g.root_index(), 4, 1)
g.add_to(cell, 0, 0, 20, 1)
g.add_to(cell, 0, 0, 30, 1)
g.add(0, 0, 50, 1)
g.compute(400, 500)
Console.write(g.fmt_frame(1) + " " + g.fmt_frame(2) + " " + g.fmt_frame(3) + " " + g.fmt_frame(4) + "\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", platform: "macos" });
		await check_output(
			"container_nested_vstack_in_grid",
			result,
			"0,0,200,54 0,0,200,20 0,24,200,30 200,0,200,50\n",
			opts,
		);
	});
});
