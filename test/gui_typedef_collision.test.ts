import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

const ARCHS = ["aarch64", "c"] as const;

// Building a program that pulls in the GUI controls (Window/Text, whose raw
// `#arch` blocks reference the objc runtime) forces the C backend to
// `#import` Cocoa/UIKit, which drags in MacTypes.h. MacTypes defines typedefs
// like `Size`/`Point`/`Rect` that collide with Nomen's own
// `typedef struct Size {...} Size;`. This test exercises exactly that
// combination — `import System/Controls` brings both the objc raw blocks AND
// Geometry's `Size`/`BoxConstraints` structs into one translation unit — and
// must build + run on both backends. Without typedef mangling (the `nm_`
// strategy) the C backend fails to compile.
async function run(name: string, program: string, expected: string) {
	const parsed = parse_raw(program);
	expect(parsed.errors).toEqual([]);
	for (const arch of ARCHS) {
		const result = build(parsed.root, { arch, platform: "macos" });
		await check_output(`${name}_${arch}`, result, expected, { arch, audit: false });
	}
}

describe("GUI typedef collision (Size/BoxConstraints + Cocoa)", () => {
	test("Size + BoxConstraints build and run alongside GUI controls", async () => {
		await run(
			"gui_typedef_collision",
			`
import System
import System/Controls

pub func main = () {
	var Size s = Size()
	s.width = 42
	s.height = 7
	var BoxConstraints c = BoxConstraints()
	c = c.tighten_width(10, 500)
	var int clamped = c.clamp_width(s.width)
	Console.write("\\{s.width} \\{s.height} \\{clamped}")
}
`,
			"42 7 42",
		);
	}, 10000);

	test("Frame struct (also a MacTypes-colliding name) builds with GUI controls", async () => {
		await run(
			"gui_typedef_collision_frame",
			`
import System
import System/Controls

pub func main = () {
	var Frame f = Frame()
	f.x = 5
	f.y = 9
	f.width = 100
	f.height = 20
	var Insets p = Insets()
	p.top = 1
	p.bottom = 2
	Console.write("\\{f.x} \\{f.y} \\{f.width} \\{f.height} \\{p.top} \\{p.bottom}")
}
`,
			"5 9 100 20 1 2",
		);
	}, 10000);

	test("LayoutLength enum-with-data dispatches with GUI controls in the unit", async () => {
		await run(
			"gui_typedef_collision_enum",
			`
import System
import System/Controls

pub func main = () {
	var LayoutLength w = LayoutLength.fixed(50)
	var LayoutLength h = LayoutLength.percent(25)
	var int wv = match w {
		case .fixed(px) -> px
		case .auto -> 0
		case .percent(n) -> n
		case .fill -> 0
	}
	var int hv = match h {
		case .percent(n) -> n
		case .fixed(px) -> px
		case .auto -> 0
		case .fill -> 0
	}
	Console.write("\\{wv} \\{hv}")
}
`,
			"50 25",
		);
	}, 10000);
});
