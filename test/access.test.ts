import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
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
		await build_and_check_output(input, "access_get_field", "25");
	});

	test("getting string field", async () => {
		const input = `
struct Person {
  var string name
}
var Person p = Person("Alice")
Console.write("\\{p.name}")
`;
		await build_and_check_output(input, "access_get_string_field", "Alice");
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
		await build_and_check_output(input, "access_set_field", "20");
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
		await build_and_check_output(input, "access_get_set_field", "30");
	});

	test("field used in expression", async () => {
		const input = `
struct MyPoint {
  var int x
  var int y
}
var MyPoint p = MyPoint(3, 4)
const sum = p.x + p.y
Console.write("\\{sum}")
`;
		await build_and_check_output(input, "access_field_expr", "7");
	});

	test("multiple instances independent", async () => {
		const input = `
struct MyPoint {
  var int x
  var int y
}
var MyPoint a = MyPoint(10, 20)
var MyPoint b = MyPoint(30, 40)
a.x = 50
Console.write("\\{a.x} \\{a.y} \\{b.x}")
`;
		await build_and_check_output(input, "access_multi_fields", "50 20 30");
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
		await build_and_check_output(input, "access_method_return", "42");
	});

	test("method using field arithmetic", async () => {
		const input = `
struct MyRect {
  var int width = 0
  var int height = 0
  func area = (self, out int) {
    return self.width * self.height
  }
}
var MyRect r = MyRect()
r.width = 5
r.height = 6
Console.write("\\{r.area()}")
`;
		await build_and_check_output(input, "access_method_arithmetic", "30");
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

		await build_and_check_output(input, "access_static_func", "42");
	});

	test("array index access", async () => {
		const input = `
var nums = Array.with(0, 3)
nums.set(0, 10)
nums.set(1, 20)
nums.set(2, 30)
Console.write("\\{nums.at(0)} \\{nums.at(1)} \\{nums.at(2)}")
`;
		await build_and_check_output(input, "access_array_index", "10 20 30");
	});

	test("array index with variable", async () => {
		const input = `
var nums = Array.with(0, 3)
nums.set(0, 100)
nums.set(1, 200)
nums.set(2, 300)
var i = 1
Console.write("\\{nums.at(i)}")
`;
		await build_and_check_output(input, "access_array_var_index", "200");
	});

	test("field update then method call", async () => {
		const input = `
struct Counter {
  var int count = 0
  func increment = (ref self) {
    self.count = self.count + 1
  }
}
var Counter c = Counter()
c.increment()
c.increment()
c.increment()
Console.write("\\{c.count}")
`;
		await build_and_check_output(input, "access_field_update_method", "3");
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
p.age = Array(1, 2)
`;
		const expected = [
			test_error(input, "Type mismatch in assignment: Array<int> (expected int)", 6, 9),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("type mismatch setting field -- array 2", () => {
		const input = `
struct Person {
  var Array<int> ages
}
var Person p
p.ages = 3
`;
		const expected = [
			test_error(input, "Type mismatch in assignment: int (expected Array<int>)", 6, 10),
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
