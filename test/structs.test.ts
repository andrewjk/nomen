import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
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
		await build_and_check_output(input, "struct_int_field", "25");
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
		await build_and_check_output(input, "struct_string_field", "Alice");
	});

	test("struct with string array field", async () => {
		const input = `
struct Container {
  var string[] items
}
var c = Container(["hello", "world"])
Console.write("\\{c.items.at(0)}\\{c.items.at(1)}")
`;
		await build_and_check_output(input, "struct_string_array_field", "helloworld");
	});

	test("struct with string array field and explicit type", async () => {
		const input = `
struct Container {
  var string[] items
}
var Container c = Container(["hello", "world"])
Console.write("\\{c.items.at(0)}\\{c.items.at(1)}")
`;
		await build_and_check_output(input, "struct_string_array_field_explicit", "helloworld");
	});

	// BROKEN: constructor stores a pointer instead of copying elements inline
	test("struct with fixed-size string array field", async () => {
		const input = `
struct Holder {
  var int argc
  var string[2] args
}
var Holder h = Holder(0, ["first", "second"])
Console.write("\\{h.args.at(0)}\\{h.args.at(1)}")
`;
		await build_and_check_output(input, "struct_fixed_size_string_array_field", "firstsecond");
	});

	// BROKEN: same issue with int arrays
	test("struct with fixed-size int array field", async () => {
		const input = `
struct Nums {
  var int[3] values
}
var Nums n = Nums([10, 20, 30])
Console.write("\\{n.values.at(0)} \\{n.values.at(1)} \\{n.values.at(2)}")
`;
		await build_and_check_output(input, "struct_fixed_size_int_array_field", "10 20 30");
	});

	// Regression: inlined .at() on a fixed-size array field of a struct *parameter*
	// must not corrupt the struct's home register (x19). Reading the array field
	// shifts x19 by the field offset; without preserving x19, the subsequent scalar
	// field read returns the wrong value (e.g. reads values[1] instead of `total`).
	test("struct param array field access preserves struct register", async () => {
		const input = `
struct Nums {
  var int total
  var int[3] values
}

func first_then_total = (Nums n, out int) {
  var int first = n.values.at(0)
  return n.total
}

var Nums n = Nums(7, [10, 20, 30])
var int result = first_then_total(n)
Console.write("\\{result}")
`;
		await build_and_check_output(input, "struct_param_array_field_register", "7");
	});

	test("struct with default field value", async () => {
		const input = `
struct Counter {
  var int count = 0
}
var Counter c = Counter()
Console.write("\\{c.count}")
`;
		await build_and_check_output(input, "struct_default_field", "0");
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
		await build_and_check_output(input, "struct_field_get_set", "10 20");
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
		await build_and_check_output(input, "struct_method_return", "42");
	});

	test("struct mutating method", async () => {
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
		await build_and_check_output(input, "struct_mutating_method", "3");
	});

	test("struct method with default param", async () => {
		const input = `
struct Adder {
  var int base = 0
  pub func add = (self, int n = 3, out int) {
    return self.base + n
  }
}
var Adder a = Adder()
Console.write("\\{a.add()} \\{a.add(10)}")
`;
		await build_and_check_output(input, "struct_method_default_param", "3 10");
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
		await build_and_check_output(input, "struct_static_func", "10");
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
		await build_and_check_output(input, "struct_field_update", "10 4");
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
		await build_and_check_output(input, "struct_method_arithmetic", "42");
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
		await build_and_check_output(input, "struct_multiple_instances", "10 20");
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
		await build_and_check_output(input, "struct_constructed_params", "3 4");
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
var Person p = Person(0)
const x = p.name
`;
		const expected = [test_error(input, "Field not found: name", 6, 13)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("self used in method body without being declared as a parameter", () => {
		// `read`'s body references `self.x` but its param list has no `self`.
		// This must surface as a clean error (not a hang/crash) — `self` is
		// not an implicit receiver; methods that use it must declare it.
		const input = `
struct P {
	var int x
	pub func read = (out int) {
		return self.x
	}
}
`;
		const parsed = parse(input);
		const messages = parsed.errors.map((e) => e.message);
		expect(messages).toContain("Unknown value: self");
	});

	test("self used in generic #init body without being declared as a parameter", () => {
		// Same contract on a generic struct's custom #init: using `self`
		// without declaring it must error cleanly, not hang the checker
		// (regression guard — generic custom #init used to loop forever here).
		const input = `
struct Bag<T> {
	var T item
	pub func #init = (...T items) {
		self.item = items.at(0)
	}
}
func main = () {
	var Bag<int> b = Bag<int>(1)
}
`;
		const parsed = parse(input);
		const messages = parsed.errors.map((e) => e.message);
		expect(messages).toContain("Unknown value: self");
	});

	test("immutable self param cannot be mutated", () => {
		// A bare `self` (not `var self`/`ref self`) is an immutable borrow.
		// Assigning to one of its fields must be rejected.
		const input = `
struct P {
	var int x
	pub func set_x = (self, int v) {
		self.x = v
	}
}
`;
		const parsed = parse(input);
		const messages = parsed.errors.map((e) => e.message);
		expect(messages.some((m) => m.includes("self") && m.includes("mutat"))).toBe(true);
	});
});
