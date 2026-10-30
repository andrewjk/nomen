import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// An `inline func` method on a trait-conforming struct must emit a
// standalone body: the struct's vtable is generated unconditionally and
// references every method label, so a skipped inline method left a dangling
// symbol and the program failed to link (aarch64 — the C backend always
// emitted every method). With the body emitted, vtable dispatch works, and a
// DEVIRTUALIZED call (a trait-typed local whose conformer is provably known
// — PERF_PLAN item 11) splices the body at the call site: no call, no
// vtable walk.

const PRELUDE = `
trait Shape {
	func area = (self, out int)
}

mv struct Tile: Shape {
	var int side
	pub inline func area = (self, out int) {
		return self.side * self.side
	}
}

mv struct Rect: Shape {
	var int w
	var int h
	pub inline func area = (self, out int) {
		return self.w * self.h
	}
}
`;

function build_aarch64(input: string): string {
	const parsed = parse_raw(`import System\n${input}`);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	return result.code ?? "";
}

describe("inline trait-conforming methods", () => {
	test("links and dispatches through the vtable (aarch64)", () => {
		const code = build_aarch64(
			PRELUDE +
				`
pub func main = (Init init) {
	var Shape t = Tile(7)
	if init.argc > 99 {
		t = Rect(2, 3)
	}
	Console.write("\\{t.area()}")
}`,
		);
		// The standalone bodies exist (the vtables reference them) and the
		// reassignment across conformers keeps one vtable-dispatched site.
		expect(code).toMatch(/Tile_area:/);
		expect(code).toMatch(/Rect_area:/);
		expect(code).toContain("blr x10");
	});

	test("devirtualized call splices the inline body — no call, no vtable walk", () => {
		const code = build_aarch64(
			PRELUDE +
				`
pub func main = (Init init) {
	var Shape t = Tile(7)
	Console.write("\\{t.area()}")
}`,
		);
		// The known-conformer site takes the splice: no bl to the method and
		// no indirect dispatch — the body's multiply is inline in main.
		expect(code).not.toContain("bl Tile_area");
		expect(code).not.toContain("blr x10");
		expect(code).toMatch(/mul\s+x0, x1, x2/);
	});

	test("runtime: devirtualized and vtable-dispatched inline calls agree", async () => {
		await build_and_check_output(
			PRELUDE +
				`
var Shape t = Tile(7)
var Shape u = Tile(9)
Console.write("\\{t.area()} \\{u.area()}")
var Shape r = Rect(2, 5)
Console.write("\\{r.area()}")
var Shape p = Tile(3)
p = Rect(3, 4)
Console.write("\\{p.area()}")`,
			"trait_inline_runtime",
			"49 811012",
		);
	});

	test("runtime: inline method through a trait param dispatches", async () => {
		await build_and_check_output(
			PRELUDE +
				`
func report = (Shape s, out int) {
	return s.area()
}
Console.write("\\{report(Tile(6))} \\{report(Rect(2, 3))}")`,
			"trait_inline_param",
			"36 6",
		);
	});
});
