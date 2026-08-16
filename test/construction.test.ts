import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
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
		await build_and_check_output(input, "construct_empty", "ok");
	});

	test("construct struct with string param", async () => {
		const input = `
struct Person {
  var string name
}
var Person p = Person("Andrew")
Console.write("\\{p.name}")
`;
		await build_and_check_output(input, "construct_string_param", "Andrew");
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
		await build_and_check_output(input, "construct_default_field", "Bob 0");
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
		await build_and_check_output(input, "construct_multi_param", "3 4");
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
		await build_and_check_output(input, "construct_field_expr", "30");
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
		await build_and_check_output(input, "construct_modify_field", "15");
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
		await build_and_check_output(input, "construct_two_instances", "100 200");
	});

	test("custom #init with a ref param round-trips the caller's value", async () => {
		// A `ref` init param must lower to a pointer in the synthesized
		// constructor signature AND be dereferenced at body use sites —
		// previously the signature was by-value while the call site passed
		// `&arg` (garbage read). Locked by the shared param classification
		// (classify_param) both signature sites use.
		const input = `
struct Scale {
  var int factor = 1
  pub func #init = (self, ref int n) {
    self.factor = n
  }
}
var int a = 7
var Scale s = Scale(ref a)
Console.write("\\{s.factor}")
`;
		await build_and_check_output(input, "construct_ref_init_param", "7");
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
		const expected = Array(
			test_error(input, "Type mismatch in param: int (expected string)", 5, 17),
		);
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
