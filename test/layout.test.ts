import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

const opts = { arch: "aarch64", audit: false } as const;

describe("layout engine", () => {
	test("single leaf gets its intrinsic size", async () => {
		const input = `
var Layout l = Layout()
init_layout(ref l, 16)
var int root = add_leaf(ref l, -1, 100, 50)
run_layout(ref l, 1, root, 800, 600)
Console.write(fmt(l, root) + "\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("layout_leaf", result, "{0,0 100x50}\n", opts);
	});

	test("leaf clamps to available space", async () => {
		const input = `
var Layout l = Layout()
init_layout(ref l, 16)
var int root = add_leaf(ref l, -1, 1000, 1000)
run_layout(ref l, 1, root, 200, 100)
Console.write(fmt(l, root) + "\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("layout_clamp", result, "{0,0 200x100}\n", opts);
	});

	test("vstack stacks children vertically", async () => {
		const input = `
var Layout l = Layout()
init_layout(ref l, 16)
var int root = add_vstack(ref l, -1, 0)
var int a = add_leaf(ref l, root, 80, 30)
var int b = add_leaf(ref l, root, 120, 40)
run_layout(ref l, 3, root, 800, 600)
Console.write("a=" + fmt(l, a) + " b=" + fmt(l, b) + "\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("layout_vstack", result, "a={0,0 120x30} b={0,30 120x40}\n", opts);
	});

	test("vstack with spacing", async () => {
		const input = `
var Layout l = Layout()
init_layout(ref l, 16)
var int root = add_vstack(ref l, -1, 10)
var int a = add_leaf(ref l, root, 50, 20)
var int b = add_leaf(ref l, root, 50, 20)
run_layout(ref l, 3, root, 800, 600)
Console.write("a=" + fmt(l, a) + " b=" + fmt(l, b) + "\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("layout_vstack_spacing", result, "a={0,0 50x20} b={0,30 50x20}\n", opts);
	});

	test("hstack stacks children horizontally", async () => {
		const input = `
var Layout l = Layout()
init_layout(ref l, 16)
var int root = add_hstack(ref l, -1, 0)
var int a = add_leaf(ref l, root, 30, 50)
var int b = add_leaf(ref l, root, 60, 80)
run_layout(ref l, 3, root, 800, 600)
Console.write("a=" + fmt(l, a) + " b=" + fmt(l, b) + "\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("layout_hstack", result, "a={0,0 30x80} b={30,0 60x80}\n", opts);
	});

	test("nested vstack inside hstack", async () => {
		const input = `
var Layout l = Layout()
init_layout(ref l, 16)
var int root = add_hstack(ref l, -1, 0)
var int col = add_vstack(ref l, root, 0)
var int a = add_leaf(ref l, col, 40, 25)
var int b = add_leaf(ref l, col, 40, 35)
var int sidebar = add_leaf(ref l, root, 100, 60)
run_layout(ref l, 5, root, 800, 600)
Console.write("a=" + fmt(l, a) + " b=" + fmt(l, b) + " s=" + fmt(l, sidebar) + "\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output(
			"layout_nested",
			result,
			"a={0,0 40x25} b={0,25 40x35} s={40,0 100x60}\n",
			opts,
		);
	});
});
