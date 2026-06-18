import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("struct build", () => {
	test("struct with int field", async () => {
		const input = `
struct Person {
  var int age = 0
}
var Person p
p.age = 25
Console.write("\\{p.age}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("struct_int_field", result, "25");
	});

	test("struct with string field", async () => {
		const input = `
struct Person {
  var string name
  var int age = 0
}
var Person p = Person("Alice")
Console.write("\\{p.name}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("struct_string_field", result, "Alice");
	});

	test("struct with string array field", async () => {
		const input = `
struct Container {
  var string[] items
}
var c = Container(["hello", "world"])
Console.write("\\{c.items[0]}\\{c.items[1]}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("struct_string_array_field", result, "helloworld");
	});

	test("struct with default field value", async () => {
		const input = `
struct Counter {
  var int count = 0
}
var Counter c = Counter()
Console.write("\\{c.count}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("struct_default_field", result, "0");
	});

	test("struct field get and set", async () => {
		const input = `
struct Point {
  var int x
  var int y
}
var Point p = Point(10, 20)
Console.write("\\{p.x} \\{p.y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("struct_field_get_set", result, "10 20");
	});

	test("struct method returning value", async () => {
		const input = `
struct Person {
  var int age = 0
  func get_age = (self, out int) {
    return self.age
  }
}
var Person p = Person()
p.age = 42
const age = p.get_age()
Console.write("\\{age}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("struct_method_return", result, "42");
	});

	test("struct mutating method", async () => {
		const input = `
struct Counter {
  var int count = 0
  func increment = (var self) {
    self.count = self.count + 1
  }
}
var Counter c = Counter()
c.increment()
c.increment()
c.increment()
Console.write("\\{c.count}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("struct_mutating_method", result, "3");
	});

	test("struct static function", async () => {
		const input = `
struct Calc {
  func add = (int a, int b, out int) {
    return a + b
  }
}
const result = Calc.add(3, 7)
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("struct_static_func", result, "10");
	});

	test("struct field update and read", async () => {
		const input = `
struct Point {
  var int x
  var int y
}
var Point p = Point(3, 4)
p.x = 10
Console.write("\\{p.x} \\{p.y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("struct_field_update", result, "10 4");
	});

	test("struct with method using field arithmetic", async () => {
		const input = `
struct Rect {
  var int width = 0
  var int height = 0
  func area = (self, out int) {
    return self.width * self.height
  }
}
var Rect r = Rect()
r.width = 6
r.height = 7
Console.write("\\{r.area()}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("struct_method_arithmetic", result, "42");
	});

	test("multiple struct instances", async () => {
		const input = `
struct Point {
  var int x
  var int y
}
var Point a = Point(10, 30)
var Point b = Point(20, 40)
Console.write("\\{a.x} \\{b.x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("struct_multiple_instances", result, "10 20");
	});

	test("struct constructed with required fields", async () => {
		const input = `
struct Point {
  var int x
  var int y
}
var Point p = Point(3, 4)
Console.write("\\{p.x} \\{p.y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("struct_constructed_params", result, "3 4");
	});
});

// ERRORS
describe("struct errors", () => {
	test("invalid syntax", () => {
		const input = `
struct Person People {}
`;
		const expected = [test_error(input, "Expected {", 2, 15)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("child struct", () => {
		const input = `
struct Person {
  struct People {}
}
`;
		const expected = [test_error(input, "Struct cannot appear here", 3, 3)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("child assignment", () => {
		const input = `
struct Person {
  var int x
  x = 5
}
`;
		const expected = [test_error(input, "Assignment cannot appear here", 4, 3)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("field type mismatch on construction", () => {
		const input = `
struct Dog {
  var string name
}
const dog = Dog(5)
`;
		const expected = [test_error(input, "Type mismatch in param: int (expected string)", 5, 17)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("unknown field access", () => {
		const input = `
struct Person {
  var int age
}
var Person p
const x = p.name
`;
		const expected = [test_error(input, "Field not found: name", 6, 13)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
