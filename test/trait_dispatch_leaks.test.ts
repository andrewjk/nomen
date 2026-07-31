import path from "node:path";

import { expect, test } from "vite-plus/test";

import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";
import build_and_check_output from "./build_and_check_output";

const system = get_library(path.resolve("core"));

// Regression test for an aarch64 leak surfaced by making `Container` a `class`.
//
// `VStack`/`HStack`/`Grid`/`ZStack` are free functions in the trusted core
// library that return a fresh `Container` instance (a class). `main` is built
// BEFORE the library, so at the call site the callee was not yet registered in
// `heap_returning_functions`, `last_result_is_heap` stayed false, and the
// aarch64 declaration builder never anchored the returned instance — the
// field destroys ran at scope exit (the 25 Buffer_int_destroy calls) but the
// instance `malloc` itself was never freed. (The C backend was always clean;
// it derives cleanup from the declared type, not the heap-return set.)
//
// Fix: `build_aarch64/build_declaration_node.ts` — a non-constructor free
// function returning a class always hands the caller an owned instance, so the
// heap flag is forced before `check_heap` anchors it. These tests hold a
// `Container` from each factory under `audit` on both backends.

test("VStack result is freed (no leak) on both backends", async () => {
	await build_and_check_output(
		`
var Container v = VStack(0)
v.add(0, 0, 30, 1)
Console.write("ok\\n")
`,
		"factory_vstack_leak",
		"ok",
	);
});

test("HStack result is freed (no leak) on both backends", async () => {
	await build_and_check_output(
		`
var Container v = HStack(0)
v.add(0, 30, 0, 1)
Console.write("ok\\n")
`,
		"factory_hstack_leak",
		"ok",
	);
});

test("Grid result is freed (no leak) on both backends", async () => {
	await build_and_check_output(
		`
var Container v = Grid(2, 8)
v.add(0, 0, 30, 2)
Console.write("ok\\n")
`,
		"factory_grid_leak",
		"ok",
	);
});

test("ZStack result is freed (no leak) on both backends", async () => {
	await build_and_check_output(
		`
var Container v = ZStack()
v.add(0, 100, 50, 1)
Console.write("ok\\n")
`,
		"factory_zstack_leak",
		"ok",
	);
});

// A trait-dispatched `measure` on the class conformer also stays leak-free once
// the factory result is anchored (this is the path the original report came in
// on — calling Container.measure through the Control vtable).
test("Container driven through the Control trait is freed (no leak)", async () => {
	const input = `
import System/Controls
func height_of = (Control c, out int) {
	var BoxConstraints bc = BoxConstraints()
	bc.max_width = 800
	bc.max_height = 600
	var Size s = c.measure(bc)
	return s.height
}
pub func main = () {
	var Container v = VStack(0)
	v.add(0, 0, 30, 1)
	v.add(0, 0, 40, 1)
	Console.write(height_of(v).to_string() + "\\n")
}
`;
	const parsed = parse(input, system);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "factory_trait_dispatch_leak", "70", true);
});
