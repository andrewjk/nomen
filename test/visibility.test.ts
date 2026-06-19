import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import test_error from "./test_error";

describe("visibility errors", () => {
	test("invalid target", () => {
		const input = `
pub if true {
  // ...
}
`;
		const expected = [
			test_error(
				input,
				"Visibility can only be set for const, var, mov, class, struct, trait or func",
				2,
				1,
			),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("accessing private fields from outside struct", () => {
		const input = `
struct Person {
  private var string name
  private func greet = () {}
}
var Person x = Person()
x.name = "Andrew"
x.greet()
`;
		const expected = [
			test_error(input, "Can't access private field: name", 7, 3),
			test_error(input, "Can't access private function: greet", 8, 3),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("private fields in trait", () => {
		const input = `
trait Person {
  private var string name
  private func greet = () {}
}
`;
		const expected = [
			test_error(input, "Trait fields cannot be private", 3, 3),
			test_error(input, "Trait functions cannot be private", 4, 3),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("private fields accessible from own struct methods", () => {
		const input = `
struct Counter {
  private var int count = 0
  func increment = (self) {
    self.count = self.count + 1
  }
  func get = (self, out int) {
    return self.count
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("private file-level function accessible from same file", () => {
		const input = `
private func helper = (out int) {
  return 42
}
var int x = helper()
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("private file-level struct accessible from same file", () => {
		const input = `
private struct Point {
  var int x = 0
  var int y = 0
}
var Point p = Point()
p.x = 10
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("private file-level enum accessible from same file", () => {
		const input = `
private enum Color {
  case Red
  case Green
  case Blue
}
var Color c = Color.Red
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("private file-level bitset accessible from same file", () => {
		const input = `
private bitset Flags {
  case Read
  case Write
  case Execute
}
var Flags f = Flags.Read
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("pub struct fields accessible from outside", () => {
		const input = `
struct Point {
  pub var int x = 0
  pub var int y = 0
}
var Point p = Point()
p.x = 10
p.y = 20
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("pub function accessible from outside", () => {
		const input = `
pub func add = (int a, int b, out int) {
  return a + b
}
var int result = add(1, 2)
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("private function not accessible from outside struct", () => {
		const input = `
struct Foo {
  private func secret = (out int) {
    return 42
  }
}
var Foo f = Foo()
f.secret()
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(input, "Can't access private function: secret", 8, 3),
		]);
	});

	test("private field on different struct not accessible", () => {
		const input = `
struct Outer {
  private var int value = 0
}
struct Inner {
  var Outer outer
  func doStuff = (self) {
    self.outer.value = 5
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([test_error(input, "Can't access private field: value", 8, 16)]);
	});

	test("private function in function scope", () => {
		const input = `
func main = () {
  private func local = (out int) {
    return 10
  }
  var int x = local()
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("private const accessible within same block", () => {
		const input = `
func main = () {
  private const int MAX = 100
  var int x = MAX
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("default visibility - struct members are pub by default", () => {
		const input = `
struct Point {
  var int x = 0
  var int y = 0
}
var Point p = Point()
p.x = 10
p.y = 20
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("default visibility - file-level items are private by default", () => {
		const input = `
struct Helper {
  var int value = 0
}
func useHelper = () {
  var Helper h = Helper()
}
`;
		const parsed = parse(input);
		// Both are file-level private, but accessible from same file
		expect(parsed.errors).toEqual([]);
	});

	test("mixed visibility - pub and private fields", () => {
		const input = `
struct User {
  pub var string name
  private var int age = 0
  pub func getName = (self, out string) {
    return self.name
  }
  private func getAge = (self, out int) {
    return self.age
  }
}
var User u = User("Alice")
u.getName()
u.age
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([test_error(input, "Can't access private field: age", 14, 3)]);
	});

	test("pub struct constructor accessible from same file", () => {
		const input = `
pub struct Point {
  var int x = 0
}
var Point p = Point()
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("struct method accessing private field via self parameter", () => {
		const input = `
struct Foo {
  private var int x = 0
  func setX = (ref self, int val) {
    self.x = val
  }
  func getX = (self, out int) {
    return self.x
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("multiple private items in same struct", () => {
		const input = `
struct Widget {
  private var int id = 0
  private var string label = ""
  private func reset = (self) {
    self.id = 0
    self.label = ""
  }
  func getId = (self, out int) {
    return self.id
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("pub struct accessible from different function in same file", () => {
		const input = `
pub struct Container {
  var int value = 0
}
func create = (out Container) {
  return Container()
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("private field accessible from method on same struct", () => {
		const input = `
struct Counter {
  private var int count = 0
  func decrement = (self) {
    self.count = self.count - 1
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});
});
