import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

// BUILD
describe("trait build", () => {
	test("trait with struct field access", async () => {
		const input = `
trait Person {
  var string name
}

struct Frank: Person {
  var string name = "Frank"
}

const f = Frank()
Console.write(f.name)
`;
		await build_and_check_output(input, "trait_field_access", "Frank");
	});

	test("trait with struct method override", async () => {
		const input = `
trait Person {
  func greet = (out string) {
    return "hi"
  }
}

struct Frank: Person {
  func greet = (out string) {
    return "hello from Frank"
  }
}

const f = Frank()
Console.write(f.greet())
`;
		await build_and_check_output(input, "trait_method_override", "hello from Frank");
	});

	test("trait with default method implementation", async () => {
		const input = `
trait Person {
  var string name
  func greet = (out string) {
    return "hi"
  }
}

struct Frank: Person {
  var string name = "Frank"
}

const f = Frank()
Console.write(f.greet())
`;
		await build_and_check_output(input, "trait_default_method", "hi");
	});

	test("trait with int field and default", async () => {
		const input = `
trait Counter {
  var int count = 0
}

struct MyCounter: Counter {
  var int count = 5
}

const c = MyCounter()
Console.write("\\{c.count}")
`;
		await build_and_check_output(input, "trait_int_field", "5");
	});

	test("struct with multiple traits", async () => {
		const input = `
trait Greeter {
  func greet = (out string) {
    return "hi"
  }
}

trait Dancer {
  func dance = (out string) {
    return "dance"
  }
}

struct Frank: Greeter, Dancer {
  func greet = (out string) {
    return "hello"
  }
}

const f = Frank()
Console.write("\\{f.greet()} \\{f.dance()}")
`;
		await build_and_check_output(input, "trait_multiple", "hello dance");
	});

	test("trait method using struct fields", async () => {
		const input = `
trait Person {
  var string name
  func greet = (self, out string) {
    return self.name
  }
}

struct Frank: Person {
  var string name = "Frank"
}

const f = Frank()
Console.write(f.greet())
`;
		await build_and_check_output(input, "trait_method_using_fields", "Frank");
	});

	test("trait with int field and method", async () => {
		const input = `
trait Counter {
  var int count
  func value = (self, out int) {
    return self.count
  }
}

struct MyCounter: Counter {
  var int count = 42
}

const c = MyCounter()
Console.write("\\{c.value()}")
`;
		await build_and_check_output(input, "trait_int_field_method", "42");
	});

	test("multiple struct instances from same trait", async () => {
		const input = `
trait Person {
  var string name
}

struct Alice: Person {
  var string name = "Alice"
}

struct Bob: Person {
  var string name = "Bob"
}

const a = Alice()
const b = Bob()
Console.write("\\{a.name} \\{b.name}")
`;
		await build_and_check_output(input, "trait_multi_instances", "Alice Bob");
	});

	test("trait with multiple fields", async () => {
		const input = `
trait Person {
  var string name
  var int age
}

struct Frank: Person {
  var string name = "Frank"
  var int age = 30
}

const f = Frank()
Console.write("\\{f.name} \\{f.age}")
`;
		await build_and_check_output(input, "trait_multi_fields", "Frank 30");
	});

	test("empty trait", async () => {
		const input = `
trait Empty {}

struct Foo: Empty {}
`;
		await build_and_check_output(input, "trait_empty", "");
	});
});

test("trait struct in function", async () => {
	const input = `
trait Named {
  var string name
}

struct Alice: Named {
  var string name = "Alice"
}

func get_name = (Alice a, out string) {
  return a.name
}
Console.write(get_name(Alice()))
`;
	await build_and_check_output(input, "trait_struct_in_func", "Alice");
});

test("trait struct method without self", async () => {
	const input = `
trait Person {
  func hello = (out string) {
    return "hello"
  }
}

struct Frank: Person {
  func hello = (out string) {
    return "hello from Frank"
  }
}

const f = Frank()
Console.write(f.hello())
`;
	await build_and_check_output(input, "trait_method_no_self", "hello from Frank");
});

test("trait struct field update", async () => {
	const input = `
trait Counter {
  var int count
}

struct MyCounter: Counter {
  var int count = 0
}

var c = MyCounter()
c.count = 10
Console.write("\\{c.count}")
`;
	await build_and_check_output(input, "trait_field_update", "10");
});

test("trait with bool field", async () => {
	const input = `
trait Status {
  var bool active
}

struct MyStatus: Status {
  var bool active = true
}

const s = MyStatus()
Console.write("\\{s.active}")
`;
	await build_and_check_output(input, "trait_bool_field", "true");
});

test("trait struct with method using fields", async () => {
	const input = `
trait Person {
  var string name
  var int age
}

struct Frank: Person {
  var string name = "Frank"
  var int age = 30
  func describe = (out string) {
    return "hello"
  }
}

const f = Frank()
Console.write(f.describe())
`;
	await build_and_check_output(input, "trait_struct_method_fields", "hello");
});

// ERRORS
describe("trait errors", () => {
	test("invalid syntax", () => {
		const input = `
trait Person People {}
`;
		const expected = [test_error(input, "Expected {", 2, 14)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("child trait", () => {
		const input = `
trait Person {
  trait People {}
}
`;
		const expected = [test_error(input, "Trait cannot appear here", 3, 3)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("child assignment", () => {
		const input = `
trait Person {
  var int x
  x = 5
}
`;
		const expected = [test_error(input, "Assignment cannot appear here", 4, 3)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("unknown trait", () => {
		const input = `
struct Frank: Person {
}
`;
		const expected = [test_error(input, "Unknown trait: Person", 2, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});

// CONFORMANCE
describe("trait conformance", () => {
	test("missing required (bodyless) method", () => {
		const input = `
trait Drawable {
  func draw = (self)
}

struct Circle: Drawable {
}
`;
		const expected = [
			test_error(
				input,
				"Type 'Circle' does not conform to trait 'Drawable': missing required method 'draw'",
				6,
				1,
			),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("override with wrong parameter type does not conform", () => {
		const input = `
trait Speaker {
  func say = (self, int n)
}

struct Parrot: Speaker {
  func say = (self, string n) {
    return
  }
}
`;
		const expected = [
			test_error(
				input,
				"Type 'Parrot' does not conform to trait 'Speaker': method 'say' does not match the trait signature",
				7,
				3,
			),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("override with wrong return type does not conform", () => {
		const input = `
trait Counter {
  func value = (self, out int)
}

struct C: Counter {
  func value = (self, out string) {
    return ""
  }
}
`;
		const expected = [
			test_error(
				input,
				"Type 'C' does not conform to trait 'Counter': method 'value' does not match the trait signature",
				7,
				3,
			),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("override with wrong parameter count does not conform", () => {
		const input = `
trait Adder {
  func add = (self, int a, int b)
}

struct A: Adder {
  func add = (self, int a) {
    return
  }
}
`;
		const expected = [
			test_error(
				input,
				"Type 'A' does not conform to trait 'Adder': method 'add' does not match the trait signature",
				7,
				3,
			),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("an overload matching the trait signature satisfies conformance", () => {
		const input = `
trait Speaker {
  func say = (self, int n)
}

struct Parrot: Speaker {
  func say = (self, int n) {
    return
  }
  func say = (self, string n) {
    return
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("inheriting a default body without overriding is allowed", () => {
		const input = `
trait Greeter {
  func hello = (out string) {
    return "hi"
  }
}

struct G: Greeter {
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});
});
