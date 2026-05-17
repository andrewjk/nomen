import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("trait_field_access", result, "Frank");
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("trait_method_override", result, "hello from Frank");
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("trait_default_method", result, "hi");
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("trait_int_field", result, "5");
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("trait_multiple", result, "hello dance");
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("trait_method_using_fields", result, "Frank");
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("trait_int_field_method", result, "42");
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("trait_multi_instances", result, "Alice Bob");
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
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("trait_multi_fields", result, "Frank 30");
	});

	test("empty trait", async () => {
		const input = `
trait Empty {}

struct Foo: Empty {}
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("trait_empty", result, "");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(parsed.errors).toEqual([]);
	await check_output("trait_struct_in_func", result, "Alice");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(parsed.errors).toEqual([]);
	await check_output("trait_method_no_self", result, "hello from Frank");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(parsed.errors).toEqual([]);
	await check_output("trait_field_update", result, "10");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(parsed.errors).toEqual([]);
	await check_output("trait_bool_field", result, "true");
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
	const parsed = parse_with_imports(input);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(parsed.errors).toEqual([]);
	await check_output("trait_struct_method_fields", result, "hello");
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
