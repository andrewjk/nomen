import { describe, expect, test } from "vite-plus/test";
import path from "node:path";
import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";
import build_and_check_output from "./build_and_check_output";

const system = get_library(path.resolve("core"));

// Phase 6 (GUI.md): Window/Text conform to the `Control` trait. This exercises
// the trait-dispatch path with the trait's real signatures — `measure`/`intrinsic_size`
// return a `Size` via `out`, `set_frame` is a `ref self` method, and `measure` takes a
// `BoxConstraints` struct argument — which is exactly what `Window`/`Text` implement.
describe("Control trait (Phase 6)", () => {
	test(
		"measure / intrinsic_size / set_frame dispatch through a Control receiver",
		{ timeout: 60000 },
		async () => {
			const input = `
import System/Controls/Control
import System/Controls/Geometry

struct Leaf: Control {
	var int w = 30
	var int h = 12
	func measure = (self, BoxConstraints constraints, out Size) {
		var Size s = Size()
		s.width = self.w
		s.height = self.h
		return s
	}
	func intrinsic_size = (self, out Size) {
		var Size s = Size()
		s.width = self.w
		s.height = self.h
		return s
	}
	func set_frame = (ref self, int x, int y, int width, int height) {
		self.w = width
		self.h = height
	}
}

pub func main = () {
	var Control c = Leaf()
	var Size m = c.measure(BoxConstraints())
	Console.write("\\{m.width} \\{m.height} ")
	var Size i = c.intrinsic_size()
	Console.write("\\{i.width} \\{i.height} ")
	c.set_frame(0, 0, 99, 88)
  var Size m2 = c.measure(BoxConstraints())
  Console.write("\\{m2.width} \\{m2.height}\\n")
}
`;
			const parsed = parse(input, system);
			expect(parsed.errors).toEqual([]);
			await build_and_check_output(input, "control_runtime", "30 12 30 12 99 88", true);
		},
		{ timeout: 60000 },
	);
});
