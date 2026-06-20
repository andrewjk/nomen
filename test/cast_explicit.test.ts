import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";
import test_error from "./test_error";

// BUILD
describe("explicit cast build", () => {
	test("struct to struct cast", async () => {
		const input = `
struct Dog {
	var int value

	func #op_as = (self, out Cat) {
		return Cat(self.value + 1)
	}
}

struct Cat {
	var int value

	func to_string = (self, out string) {
		return "\\{self.value}"
	}
}

const d = Dog(5)
const c = d as Cat
Console.write(c.to_string())
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("cast_struct_struct", result, "6");
	});

	test("struct cast with field access", async () => {
		const input = `
struct Id {
	var int value

	func #op_as = (self, out Name) {
		return Name(self.value + 100)
	}
}

struct Name {
	var int value

	func to_string = (self, out string) {
		return "\\{self.value}"
	}
}

const id = Id(5)
const name = id as Name
Console.write(name.to_string())
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("cast_field_access", result, "105");
	});

	test("cast inside function", async () => {
		const input = `
struct Dog {
	var int value

	func #op_as = (self, out Cat) {
		return Cat(self.value + 1)
	}
}

struct Cat {
	var int value

	func to_string = (self, out string) {
		return "\\{self.value}"
	}
}

func convert = (Dog d, out string) {
	const c = d as Cat
	return c.to_string()
}

const dog = Dog(9)
const result = convert(dog)
Console.write(result)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("cast_inside_func", result, "10");
	});

	test("cast with same value", async () => {
		const input = `
struct A {
	var int value

	func #op_as = (self, out B) {
		return B(self.value)
	}
}

struct B {
	var int value

	func to_string = (self, out string) {
		return "\\{self.value}"
	}
}

const a = A(42)
const b = a as B
Console.write(b.to_string())
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("cast_same_value", result, "42");
	});

	test("cast with int field directly", async () => {
		const input = `
struct Wrapped {
	var int value

	func #op_as = (self, out int) {
		return self.value
	}
}

const w = Wrapped(99)
const v = w as int
Console.write("\\{v}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });

		expect(parsed.errors).toEqual([]);
		await check_output("cast_to_int", result, "99");
	});
});

// ERRORS
describe("explicit cast errors", () => {
	test("cast to wrong target type", () => {
		const input = `
struct Celsius {
	var int value

	func #op_as = (self, out Fahrenheit) {
		return Fahrenheit(self.value)
	}
}

struct Fahrenheit {
	var int value
}

struct Kelvin {
	var int value
}

func test = (out int) {
	const c = Celsius(100)
	const k = c as Kelvin
	return 0
}
`;
		const expected = [
			test_error(
				input,
				"Cannot cast from Celsius to Kelvin: as operator returns Fahrenheit",
				20,
				12,
			),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("cast without as operator", () => {
		const input = `
struct Foo {
	var int value
}

struct Bar {
	var int value
}

func test = (out int) {
	const f = Foo(1)
	const b = f as Bar
	return 0
}
`;
		const expected = [test_error(input, "Cannot cast from Foo to Bar", 12, 12)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
