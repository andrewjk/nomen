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

	// grow (flex): the root stack fills its main axis (the available space), and
	// any surplus is shared between children weighted by `grow`. Children with
	// grow=0 hold at their intrinsic size.
	test("vstack grow: one flex child absorbs the vertical surplus", async () => {
		await run(
			"container_vstack_grow_one",
			`
var Container v = VStack(0)
v.add(0, 0, 30, 1, 0)
v.add(0, 0, 30, 1, 1)
v.compute(800, 600)
Console.write(v.fmt_frame(1) + " " + v.fmt_frame(2) + "\\n")
`,
			"0,0,800,30 0,30,800,570\n",
		);
	});

	test("vstack grow: surplus split by weight (1 and 2)", async () => {
		await run(
			"container_vstack_grow_split",
			`
var Container v = VStack(0)
v.add(0, 0, 30, 1, 1)
v.add(0, 0, 30, 1, 2)
v.compute(800, 600)
Console.write(v.fmt_frame(1) + " " + v.fmt_frame(2) + "\\n")
`,
			"0,0,800,210 0,210,800,390\n",
		);
	});

	test("hstack grow: fixed + pure-flex + fixed-with-grow share width", async () => {
		await run(
			"container_hstack_grow",
			`
var Container h = HStack(0)
h.add(0, 50, 30, 1, 0)
h.add(0, 0, 30, 1, 1)
h.add(0, 50, 30, 1, 1)
h.compute(800, 600)
Console.write(h.fmt_frame(1) + " " + h.fmt_frame(2) + " " + h.fmt_frame(3) + "\\n")
`,
			"0,0,50,30 50,0,350,30 400,0,400,30\n",
		);
	});

	// Cross-axis alignment: a child smaller than the stack's cross axis is
	// positioned by align (start/center/end); stretch (the default) fills it.
	test("hstack align: start/center/end/stretch position children vertically", async () => {
		await run(
			"container_hstack_align",
			`
var Container h = HStack(0)
h.add(0, 50, 30, 1, 0, ALIGN_START)
h.add(0, 50, 30, 1, 0, ALIGN_CENTER)
h.add(0, 50, 30, 1, 0, ALIGN_END)
h.add(0, 50, 80, 1, 0, ALIGN_STRETCH)
h.compute(800, 600)
Console.write(h.fmt_frame(1) + " " + h.fmt_frame(2) + " " + h.fmt_frame(3) + " " + h.fmt_frame(4) + "\\n")
`,
			"0,0,50,30 50,25,50,30 100,50,50,30 150,0,50,80\n",
		);
	});

	test("vstack align: narrow children align within the widest child's width", async () => {
		// The VStack's content width is the max child width (300, set by the
		// first child). The 100px children are then positioned within that 300
		// by their cross-axis alignment.
		await run(
			"container_vstack_align",
			`
var Container v = VStack(0)
v.add(0, 300, 30, 1, 0, ALIGN_START)
v.add(0, 100, 30, 1, 0, ALIGN_CENTER)
v.add(0, 100, 30, 1, 0, ALIGN_END)
v.compute(800, 600)
Console.write(v.fmt_frame(1) + " " + v.fmt_frame(2) + " " + v.fmt_frame(3) + "\\n")
`,
			"0,0,300,30 100,30,100,30 200,60,100,30\n",
		);
	});

	// grow + alignment compose through nesting: a VStack arranges a nested
	// HStack at the full row width (cross stretch), and the HStack then shares
	// that width between its own grow children.
	test("nested hstack with a grow child fills the row width", async () => {
		await run(
			"container_nested_hstack_grow",
			`
var Container v = VStack(8)
var int row = v.add_hstack(v.root_index(), 0, 1)
v.add_to(row, 0, 50, 30, 1, 0)
v.add_to(row, 0, 0, 30, 1, 1)
v.add(0, 0, 40, 1)
v.compute(800, 600)
Console.write(v.fmt_frame(1) + " " + v.fmt_frame(2) + " " + v.fmt_frame(3) + " " + v.fmt_frame(4) + "\\n")
`,
			"0,0,800,30 0,0,50,30 50,0,750,30 0,38,800,40\n",
		);
	});

	// shrink (deficit distribution): the mirror of grow. When the children's
	// main-axis total exceeds the available space, the deficit is shared
	// between shrinkable children weighted by `shrink`. The HStack root fills
	// its main axis to the available width, so a too-wide child set produces a
	// deficit the engine then carves off each shrinkable child.
	test("hstack shrink: equal-weight children share the deficit evenly", async () => {
		// 3 children × 400px = 1200 total. Available = 800. Deficit = 400.
		// shrink=1 each → total_shrink=3 → each loses 400/3 = 133 → 267 each.
		await run(
			"container_hstack_shrink_even",
			`
var Container h = HStack(0)
h.add(0, 400, 30, 1, 0, 3, 1)
h.add(0, 400, 30, 1, 0, 3, 1)
h.add(0, 400, 30, 1, 0, 3, 1)
h.compute(800, 600)
Console.write(h.fmt_frame(1) + " " + h.fmt_frame(2) + " " + h.fmt_frame(3) + "\\n")
`,
			"0,0,267,30 267,0,267,30 534,0,267,30\n",
		);
	});

	test("hstack shrink: deficit split by weight (1 and 3)", async () => {
		// 2 children × 500px = 1000 total. Available = 600. Deficit = 400.
		// shrink=1 + shrink=3 → total_shrink=4. Child 1 loses 400/4 = 100
		// (→ 400). Child 2 loses 400*3/4 = 300 (→ 200).
		await run(
			"container_hstack_shrink_weighted",
			`
var Container h = HStack(0)
h.add(0, 500, 30, 1, 0, 3, 1)
h.add(0, 500, 30, 1, 0, 3, 3)
h.compute(600, 100)
Console.write(h.fmt_frame(1) + " " + h.fmt_frame(2) + "\\n")
`,
			"0,0,400,30 400,0,200,30\n",
		);
	});

	test("vstack shrink: children with shrink=0 hold at intrinsic size", async () => {
		// Same deficit as the weighted test, but the first child has shrink=0
		// so it keeps its 500px width and the second absorbs the entire 400px
		// deficit (shrink=1, total_shrink=1).
		await run(
			"container_vstack_shrink_skip",
			`
var Container v = VStack(0)
v.add(0, 0, 500, 1, 0, 3, 0)
v.add(0, 0, 500, 1, 0, 3, 1)
v.compute(800, 600)
Console.write(v.fmt_frame(1) + " " + v.fmt_frame(2) + "\\n")
`,
			"0,0,800,500 0,500,800,100\n",
		);
	});

	// percent sizing: LEN_PERCENT resolves to p% of the bounded cross axis
	// (the parent's available width for a VStack child). On an unbounded axis
	// (a stack's main axis during measure) it stays 0 so grow/shrink still
	// drive the layout. `add_kind` is the explicit-size escape hatch taking
	// `LEN_*` constants directly (the ergonomic `add_len(.percent(50), …)`
	// form is blocked by an aarch64 codegen gap — see GUI.md).
	test("vstack percent: 50% and 25% of the available width", async () => {
		// Available width = 800. Child 1 → 400px (50%), child 2 → 200px (25%).
		// Heights are fixed. align=start (0) positions both at the left edge.
		await run(
			"container_vstack_percent",
			`
var Container v = VStack(0)
v.add_kind(0, LEN_PERCENT, 50, LEN_FIXED, 30, 1, 0, 0)
v.add_kind(0, LEN_PERCENT, 25, LEN_FIXED, 30, 1, 0, 0)
v.compute(800, 600)
Console.write(v.fmt_frame(1) + " " + v.fmt_frame(2) + "\\n")
`,
			"0,0,400,30 0,30,200,30\n",
		);
	});

	// Explicit LEN_* driven sizing via add_kind: each of the four cases
	// (LEN_AUTO, LEN_FIXED, LEN_PERCENT, LEN_FILL) resolves against the bounded
	// cross axis (VStack width = 800). On the unbounded main axis (height),
	// LEN_AUTO/LEN_FILL stay 0 so a flex weight would absorb the surplus; here
	// every child has a fixed height to keep the test deterministic.
	test("vstack add_kind: LEN_FIXED / LEN_PERCENT / LEN_AUTO / LEN_FILL on the cross axis", async () => {
		// Child 1 (LEN_FIXED 100) → 100px. Child 2 (LEN_PERCENT 50) → 400px.
		// Child 3 (LEN_AUTO) and child 4 (LEN_FILL) both fill the bounded axis.
		await run(
			"container_vstack_add_kind",
			`
var Container v = VStack(0)
v.add_kind(0, LEN_FIXED, 100, LEN_FIXED, 30, 1, 0, 0)
v.add_kind(0, LEN_PERCENT, 50, LEN_FIXED, 40, 1, 0, 0)
v.add_kind(0, LEN_AUTO, 0, LEN_FIXED, 50, 1, 0, 0)
v.add_kind(0, LEN_FILL, 0, LEN_FIXED, 60, 1, 0, 0)
v.compute(800, 600)
Console.write(v.fmt_frame(1) + " " + v.fmt_frame(2) + " " + v.fmt_frame(3) + " " + v.fmt_frame(4) + "\\n")
`,
			"0,0,100,30 0,30,400,40 0,70,800,50 0,120,800,60\n",
		);
	});

	// Legacy int-based `add` and `add_kind(LEN_FIXED, …)` produce identical
	// frames for the same logical size — `add(handle, w, h, …)` is just
	// `add_kind(handle, LEN_FIXED, w, LEN_FIXED, h, …)` when w/h are non-zero.
	test("add_kind LEN_FIXED matches legacy add for the same pixel size", async () => {
		await run(
			"container_add_kind_matches_legacy",
			`
var Container v = VStack(0)
v.add(0, 100, 30, 1)
v.add_kind(0, LEN_FIXED, 100, LEN_FIXED, 30, 1)
v.compute(800, 600)
Console.write(v.fmt_frame(1) + " " + v.fmt_frame(2) + "\\n")
`,
			"0,0,100,30 0,30,100,30\n",
		);
	});
});
