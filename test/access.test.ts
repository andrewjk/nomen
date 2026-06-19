import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("access build", () => {
	test("getting int field", async () => {
		const input = `
struct Person {
  var int age = 0
}
var Person p = Person()
p.age = 25
Console.write("\\{p.age}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("access_get_field", result, "25");
	});

	test("getting string field", async () => {
		const input = `
struct Person {
  var string name
}
var Person p = Person("Alice")
Console.write("\\{p.name}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("access_get_string_field", result, "Alice");
	});

	test("setting int field", async () => {
		const input = `
struct Person {
  var int age = 0
}
var Person p = Person()
p.age = 20
Console.write("\\{p.age}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("access_set_field", result, "20");
	});

	test("getting and setting field", async () => {
		const input = `
struct Person {
  var int age = 0
}
var Person p = Person()
p.age = 10
p.age = 30
Console.write("\\{p.age}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("access_get_set_field", result, "30");
	});

	test("field used in expression", async () => {
		const input = `
struct Point {
  var int x
  var int y
}
var Point p = Point(3, 4)
const sum = p.x + p.y
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("access_field_expr", result, "7");
	});

	test("multiple instances independent", async () => {
		const input = `
struct Point {
  var int x
  var int y
}
var Point a = Point(10, 20)
var Point b = Point(30, 40)
a.x = 50
Console.write("\\{a.x} \\{a.y} \\{b.x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("access_multi_fields", result, "50 20 30");
	});

	test("method returning value", async () => {
		const input = `
struct Person {
  var int age = 0
  func get_age = (self, out int) {
    return self.age
  }
}
var Person p = Person()
p.age = 42
Console.write("\\{p.get_age()}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("access_method_return", result, "42");
	});

	test("method using field arithmetic", async () => {
		const input = `
struct Rect {
  var int width = 0
  var int height = 0
  func area = (self, out int) {
    return self.width * self.height
  }
}
var Rect r = Rect()
r.width = 5
r.height = 6
Console.write("\\{r.area()}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("access_method_arithmetic", result, "30");
	});

	test("static function on struct", async () => {
		const input = `
struct Calc {
  func double = (int x, out int) {
    return x * 2
  }
}
const result = Calc.double(21)
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("access_static_func", result, "42");
	});

	test("array index access", async () => {
		const input = `
var int[3] nums
nums[0] = 10
nums[1] = 20
nums[2] = 30
Console.write("\\{nums[0]} \\{nums[1]} \\{nums[2]}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("access_array_index", result, "10 20 30");
	});

	test("array index with variable", async () => {
		const input = `
var int[3] nums
nums[0] = 100
nums[1] = 200
nums[2] = 300
var i = 1
Console.write("\\{nums[i]}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("access_array_var_index", result, "200");
	});

	test("field update then method call", async () => {
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
		await check_output("access_field_update_method", result, "3");
	});
});

// ERRORS
describe("access errors", () => {
	test("type mismatch getting field", () => {
		const input = `
struct Person {
  var string name
}
var Person p = Person("")
var int x = p.name
`;
		const expected = [
			test_error(input, "Type mismatch in declaration: string (expected int)", 6, 13),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("type mismatch setting field", () => {
		const input = `
struct Person {
  var int age
}
var Person p
p.age = "hi"
`;
		const expected = [
			test_error(input, "Type mismatch in assignment: string (expected int)", 6, 9),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("type mismatch setting field -- array", () => {
		const input = `
struct Person {
  var int age
}
var Person p
p.age = [1, 2]
`;
		const expected = [test_error(input, "Type mismatch in assignment: int[] (expected int)", 6, 9)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("type mismatch setting field -- array 2", () => {
		const input = `
struct Person {
  var int[] ages
}
var Person p
p.ages = 3
`;
		const expected = [
			test_error(input, "Type mismatch in assignment: int (expected int[])", 6, 10),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("unknown target", () => {
		const input = `
var age = person.age
`;
		const expected = [test_error(input, "Unknown value: person", 2, 11)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("field not found", () => {
		const input = `
struct Person {
  var int age
}
var Person p = Person(0)
const x = p.name
`;
		const expected = [test_error(input, "Field not found: name", 6, 13)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("unknown method", () => {
		const input = `
struct Person {
  var int age
}
var Person p = Person(0)
p.greet()
`;
		const expected = [test_error(input, "Function not found: Person.greet", 6, 3)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
