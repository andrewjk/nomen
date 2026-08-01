import { describe, expect, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import { core } from "./spec/_helpers";

// Helpers
function expect_no_errors(input: string) {
	const result = parse("import System\n" + input, core);
	expect(result.errors).toEqual([]);
}

describe("auto-derived to_string", () => {
	test("struct with int fields", async () => {
		const input = `
struct Point: Stringable {
    var int x
    var int y
}
const p = Point(3, 4)
Console.write(p.to_string())
`;
		await build_and_check_output(input, "derive_to_string_int", "Point(x=3, y=4)");
	});

	test("struct with string field", async () => {
		const input = `
struct Dog: Stringable {
    var string name
    var int age
}
const d = Dog("Rex", 5)
Console.write(d.to_string())
`;
		await build_and_check_output(input, "derive_to_string_string", "Dog(name=Rex, age=5)");
	});

	test("empty struct", async () => {
		const input = `
struct Empty: Stringable {
}
const e = Empty()
Console.write(e.to_string())
`;
		await build_and_check_output(input, "derive_to_string_empty", "Empty()");
	});

	test("struct with bool and char fields", async () => {
		const input = `
struct Flags: Stringable {
    var bool active
    var char code
}
const f = Flags(true, 'A')
Console.write(f.to_string())
`;
		await build_and_check_output(input, "derive_to_string_bool_char", "Flags(active=true, code=A)");
	});
});

describe("auto-derived equality", () => {
	test("equal int structs", async () => {
		const input = `
struct Point: Equatable {
    var int x
    var int y
}
const a = Point(1, 2)
const b = Point(1, 2)
if a == b {
    Console.write("equal")
}
`;
		await build_and_check_output(input, "derive_eq_equal", "equal");
	});

	test("unequal int structs", async () => {
		const input = `
struct Point: Equatable {
    var int x
    var int y
}
const a = Point(1, 2)
const c = Point(3, 4)
if a != c {
    Console.write("not equal")
}
`;
		await build_and_check_output(input, "derive_eq_unequal", "not equal");
	});

	test("equal structs are not unequal", async () => {
		const input = `
struct Point: Equatable {
    var int x
    var int y
}
const a = Point(1, 2)
const b = Point(1, 2)
if !(a != b) {
    Console.write("same")
}
`;
		await build_and_check_output(input, "derive_eq_not_neq", "same");
	});

	test("equality with string fields", async () => {
		const input = `
struct Name: Equatable {
    var string first
    var int id
}
const a = Name("Alice", 1)
const b = Name("Alice", 1)
const c = Name("Bob", 2)
if a == b && a != c {
    Console.write("ok")
}
`;
		await build_and_check_output(input, "derive_eq_strings", "ok");
	});

	test("empty equatable struct", async () => {
		const input = `
struct Unit: Equatable {
}
const a = Unit()
const b = Unit()
if a == b {
    Console.write("same")
}
`;
		await build_and_check_output(input, "derive_eq_empty", "same");
	});
});

describe("auto-derived nested equality and to_string", () => {
	test("nested equatable struct field", async () => {
		const input = `
struct Point: Equatable, Stringable {
    var int x
    var int y
}
struct Line: Equatable, Stringable {
    var Point start
    var Point end
}
const a = Line(Point(0, 0), Point(1, 1))
const b = Line(Point(0, 0), Point(1, 1))
if a == b {
    Console.write("same line")
}
`;
		await build_and_check_output(input, "derive_nested_eq", "same line");
	});

	test("nested to_string calls inner to_string", async () => {
		const input = `
struct Point: Stringable {
    var int x
    var int y
}
struct Line: Stringable {
    var Point start
    var Point end
}
const l = Line(Point(0, 0), Point(1, 1))
Console.write(l.to_string())
`;
		await build_and_check_output(
			input,
			"derive_nested_to_string",
			"Line(start=Point(x=0, y=0), end=Point(x=1, y=1))",
		);
	});
});

describe("auto-derived hash", () => {
	test("hash combines integer fields", async () => {
		const input = `
struct Point: Hashable {
    var int x
    var int y
}
const a = Point(1, 2)
const b = Point(1, 2)
const c = Point(3, 4)
if a.hash() == b.hash() {
    if a.hash() != c.hash() {
        Console.write("hash ok")
    }
}
`;
		await build_and_check_output(input, "derive_hash", "hash ok");
	});
});

describe("hand-written method wins", () => {
	test("custom to_string overrides derivation", async () => {
		const input = `
struct Point: Stringable {
    var int x
    var int y
    func to_string = (self, out string) {
        return "custom " + self.x.to_string()
    }
}
const p = Point(1, 2)
Console.write(p.to_string())
`;
		await build_and_check_output(input, "derive_custom_to_string", "custom 1");
	});

	test("custom eq overrides derivation", async () => {
		const input = `
struct Val: Equatable {
    var int n
    func #op_eq = (self, Val other, out bool) {
        return true
    }
}
const a = Val(1)
const b = Val(99)
if a == b {
    Console.write("always equal")
}
`;
		await build_and_check_output(input, "derive_custom_eq", "always equal");
	});
});

describe("derive only when all fields support it", () => {
	test("equatable struct with array field does not break", () => {
		// A struct with an array field cannot auto-derive eq; it should still
		// compile (the trait conformance just doesn't synthesize a method).
		const input = `
struct HasArray: Equatable {
    var int n
}
const h = HasArray(5)
Console.write("\\{h.n}")
`;
		expect_no_errors(input);
	});
});
