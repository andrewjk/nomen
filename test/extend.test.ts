import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// BUILD — each compiles on both backends (aarch64 + C) and the program is run,
// asserting the extended method behaves exactly like an in-body method.
describe("extend build", () => {
	test("extend struct with instance method", async () => {
		const input = `
struct Point {
	var int x
	var int y
}
extend struct Point {
	func doubled = (self, out int) {
		return self.x + self.y
	}
}
var p = Point(3, 4)
Console.write("\\{p.doubled()}")
`;
		await build_and_check_output(input, "extend_struct_method", "7");
	});

	test("extend class with method", async () => {
		const input = `
class Counter {
	var int count
}
extend class Counter {
	func read = (self, out int) {
		return self.count
	}
}
var c = Counter(9)
Console.write("\\{c.read()}")
`;
		await build_and_check_output(input, "extend_class_method", "9");
	});

	test("extend with ref self mutates the receiver", async () => {
		const input = `
struct Box {
	var int value
}
extend struct Box {
	func bump = (ref self) {
		self.value = self.value + 10
	}
}
var b = Box(5)
b.bump()
Console.write("\\{b.value}")
`;
		await build_and_check_output(input, "extend_ref_self", "15");
	});

	test("extend with static method", async () => {
		const input = `
struct Temperature {
	var int celsius = 0
}
extend struct Temperature {
	func boiling = (out int) {
		return 100
	}
}
Console.write("\\{Temperature.boiling()}")
`;
		await build_and_check_output(input, "extend_static", "100");
	});

	test("extend declared before the struct (forward reference)", async () => {
		const input = `
extend struct Widget {
	func label = (self, out int) {
		return self.id
	}
}
struct Widget {
	var int id
}
var w = Widget(42)
Console.write("\\{w.label()}")
`;
		await build_and_check_output(input, "extend_forward", "42");
	});

	test("multiple extends on the same struct", async () => {
		const input = `
struct Vec2 {
	var int x
	var int y
}
extend struct Vec2 {
	func sum = (self, out int) {
		return self.x + self.y
	}
}
extend struct Vec2 {
	func product = (self, out int) {
		return self.x * self.y
	}
}
var v = Vec2(3, 5)
Console.write("\\{v.sum()}\\{v.product()}")
`;
		await build_and_check_output(input, "extend_multiple", "815");
	});

	test("extend method can call an in-body method and vice versa", async () => {
		const input = `
struct Account {
	var int balance
	func credit = (ref self, int amount) {
		self.balance = self.balance + amount
	}
}
extend struct Account {
	func double_balance = (self, out int) {
		return self.balance + self.balance
	}
}
var a = Account(10)
a.credit(5)
Console.write("\\{a.double_balance()}")
`;
		await build_and_check_output(input, "extend_calls_body_method", "30");
	});
});

// ERROR HANDLING
describe("extend errors", () => {
	test("extending an unknown type is an error", () => {
		const source = `
extend struct Missing {
	func foo = (self) {
	}
}
`;
		const parsed = parse_raw(source);
		expect(parsed.errors.some((e) => e.message === "Cannot extend unknown type: Missing")).toBe(
			true,
		);
	});

	test("mismatched: extend struct on a class is an error", () => {
		const source = `
class Klass {
	var int x = 0
}
extend struct Klass {
	func foo = (self) {
	}
}
`;
		const parsed = parse_raw(source);
		expect(
			parsed.errors.some((e) => e.message === "Cannot extend class 'Klass' with extend struct"),
		).toBe(true);
	});

	test("mismatched: extend class on a struct is an error", () => {
		const source = `
struct Plain {
	var int x = 0
}
extend class Plain {
	func foo = (self) {
	}
}
`;
		const parsed = parse_raw(source);
		expect(
			parsed.errors.some((e) => e.message === "Cannot extend struct 'Plain' with extend class"),
		).toBe(true);
	});

	test("redefining an existing method is a duplicate error", () => {
		const source = `
struct S {
	var int x = 0
	func same = (self, out int) {
		return self.x
	}
}
extend struct S {
	func same = (self, out int) {
		return self.x + 1
	}
}
`;
		const parsed = parse_raw(source);
		expect(parsed.errors.some((e) => e.message === "Function already declared: same")).toBe(true);
	});

	test("extending with an overload (different params) is allowed", () => {
		const source = `
struct S {
	var int x = 0
	func go = (self, out int) {
		return self.x
	}
}
extend struct S {
	func go = (self, int y, out int) {
		return self.x + y
	}
}
`;
		const parsed = parse_raw(source);
		expect(parsed.errors).toEqual([]);
	});

	test("empty extend body is allowed", () => {
		const source = `
struct S {
	var int x = 0
}
extend struct S {
}
`;
		const parsed = parse_raw(source);
		expect(parsed.errors).toEqual([]);
	});
});
