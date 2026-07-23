import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("function overloading", () => {
	test("overloaded method by param type", async () => {
		const input = `
struct Printer {
  var int last_int
  var string last_str
  pub func print = (ref self, int value) {
    self.last_int = value
  }
  pub func print = (ref self, string value) {
    self.last_str = value
  }
}
var Printer p = Printer(0, "")
p.print(42)
p.print("hello")
Console.write("\\{p.last_int} \\{p.last_str}")
`;
		await build_and_check_output(input, "overload_print", "42 hello");
	});

	test("overloaded method with struct params", async () => {
		const input = `
struct Vec2 {
  var int x
  var int y
  pub func scale = (ref self, int s) {
    self.x = self.x * s
    self.y = self.y * s
  }
  pub func scale = (ref self, Vec2 other) {
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
		await build_and_check_output(input, "overload_struct_params", "8 12 10 18");
	});

	test("overloaded operator", async () => {
		const input = `
struct Vec2 {
  var int x
  var int y
  pub func #op_add = (self, Vec2 other, out Vec2) {
    return Vec2(self.x + other.x, self.y + other.y)
  }
  pub func #op_add = (self, int scalar, out Vec2) {
    return Vec2(self.x + scalar, self.y + scalar)
  }
}
const a = Vec2(1, 2)
const b = Vec2(3, 4)
const c = a + b
const d = a + 10
Console.write("\\{c.x} \\{c.y} \\{d.x} \\{d.y}")
`;
		await build_and_check_output(input, "overload_operator", "4 6 11 12");
	});
});
