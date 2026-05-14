import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// TODO: I think we should automatically create two constructors:
// - only necessary fields (i.e. with no default)
// - all fields

// BUILD
describe("construction build", () => {
	test("construct empty struct", async () => {
		const input = `
struct Empty {}
var Empty e = Empty()
Console.write("ok")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("construct_empty", result, "ok");
	});

	test("construct struct with string param", async () => {
		const input = `
struct Person {
  var string name
}
var Person p = Person("Andrew")
Console.write("\\{p.name}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("construct_string_param", result, "Andrew");
	});

	test("construct struct with default field", async () => {
		const input = `
struct Person {
  var string name
  var int age = 0
}
var Person p = Person("Bob")
Console.write("\\{p.name} \\{p.age}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("construct_default_field", result, "Bob 0");
	});

	test("construct struct with multiple required fields", async () => {
		const input = `
struct Point {
  var int x
  var int y
}
var Point p = Point(3, 4)
Console.write("\\{p.x} \\{p.y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("construct_multi_param", result, "3 4");
	});

	test("construct struct and use field in expression", async () => {
		const input = `
struct Point {
  var int x
  var int y
}
var Point p = Point(10, 20)
const sum = p.x + p.y
Console.write("\\{sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("construct_field_expr", result, "30");
	});

	test("construct struct and modify field", async () => {
		const input = `
struct Counter {
  var int count = 0
}
var Counter c = Counter()
c.count = 5
c.count = c.count + 10
Console.write("\\{c.count}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("construct_modify_field", result, "15");
	});

	test("construct two instances independently", async () => {
		const input = `
struct Box {
  var int value = 0
}
var Box a = Box()
var Box b = Box()
a.value = 100
b.value = 200
Console.write("\\{a.value} \\{b.value}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("construct_two_instances", result, "100 200");
	});
});

// ERRORS
describe("construction errors", () => {
	test("struct not found", () => {
		const input = `
const dog = Dog()
`;
		const expected = [test_error(input, "Function not found: Dog", 2, 13)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("too many parameters", () => {
		const input = `
struct Dog {}
const dog = Dog("Spot")
`;
		const expected = [test_error(input, "Too many parameters for function: Dog", 3, 13)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("parameters missing", () => {
		const input = `
struct Dog {
  var string name
}
const dog = Dog()
`;
		const expected = [test_error(input, "Parameters missing for function: Dog", 5, 13)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("param type mismatch", () => {
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

	test("param type mismatch -- unknown value", () => {
		const input = `
struct Dog {
  var string name
}
const dog = Dog(z0)
`;
		const expected = [test_error(input, "Unknown value: z0", 5, 17)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
