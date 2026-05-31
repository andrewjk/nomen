import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("function overloading", () => {
	test("overloaded method by param type", async () => {
		const input = `
struct Printer {
  var int last_int
  var string last_str
  pub func print = (self, int value) {
    self.last_int = value
  }
  pub func print = (self, string value) {
    self.last_str = value
  }
}
var Printer p = Printer(0, "")
p.print(42)
p.print("hello")
Console.write("\\{p.last_int} \\{p.last_str}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("overload_print", result, "42 hello");
	});

	test("overloaded method with struct params", async () => {
		const input = `
struct Vec2 {
  var int x
  var int y
  pub func scale = (self, int s) {
    self.x = self.x * s
    self.y = self.y * s
  }
  pub func scale = (self, Vec2 other) {
    self.x = self.x * other.x
    self.y = self.y * other.y
  }
}
var Vec2 v1 = Vec2(2, 3)
v1.scale(4)
var Vec2 v2 = Vec2(5, 6)
var Vec2 v3 = Vec2(2, 3)
v3.scale(v2)
Console.write("\\{v1.x} \\{v1.y} \\{v3.x} \\{v3.y}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("overload_struct_params", result, "8 12 10 18");
	});

	test("overloaded operator", async () => {
		const input = `
struct Vec2 {
  var int x
  var int y
  pub op + (self, Vec2 other, out Vec2) {
    return Vec2(self.x + other.x, self.y + other.y)
  }
  pub op + (self, int scalar, out Vec2) {
    return Vec2(self.x + scalar, self.y + scalar)
  }
}
const a = Vec2(1, 2)
const b = Vec2(3, 4)
const c = a + b
const d = a + 10
Console.write("\\{c.x} \\{c.y} \\{d.x} \\{d.y}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("overload_operator", result, "4 6 11 12");
	});
});
