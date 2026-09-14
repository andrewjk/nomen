import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("constructor overloading", () => {
	test("overloaded #init by param count and type", async () => {
		const input = `
struct Point {
  var int x
  var int y
  pub func #init = (ref self, int x, int y) {
    self.x = x
    self.y = y
  }
  pub func #init = (ref self, int x) {
    self.x = x
    self.y = 100
  }
  pub func #init = (ref self, string label) {
    self.x = label.length
    self.y = -1
  }
}
var Point a = Point(3, 4)
var Point b = Point(5)
var Point c = Point("hello")
Console.write("\\{a.x} \\{a.y} \\{b.x} \\{b.y} \\{c.x} \\{c.y}")
`;
		await build_and_check_output(input, "init_overload", "3 4 5 100 5 -1");
	});

	test("overloaded #init on a class", async () => {
		const input = `
class Box {
  pub var int v
  pub var string tag
  pub func #init = (ref self, int v) {
    self.v = v
    self.tag = "int"
  }
  pub func #init = (ref self, string tag) {
    self.v = -1
    self.tag = tag
  }
}
var Box a = Box(7)
var Box b = Box("str")
Console.write("\\{a.v} \\{a.tag} \\{b.v} \\{b.tag}")
`;
		await build_and_check_output(input, "init_overload_class", "7 int -1 str");
	});

	test("overloaded #init on a generic struct", async () => {
		const input = `
struct Holder<T> {
  var T item
  var int stamp
  pub func #init = (ref self, T item) {
    self.item = item
    self.stamp = 1
  }
  pub func #init = (ref self, T item, int stamp) {
    self.item = item
    self.stamp = stamp
  }
}
var Holder<int> a = Holder<int>(5)
var Holder<int> b = Holder<int>(5, 9)
Console.write("\\{a.item} \\{a.stamp} \\{b.item} \\{b.stamp}")
`;
		await build_and_check_output(input, "init_overload_generic", "5 1 5 9");
	});
});
