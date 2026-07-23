import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// BUG: a class that holds a struct-typed field crashes at runtime (segfault /
// exit 139), regardless of how the field is accessed.
//
// Reading the field from main, copying it into a local inside a method, or
// assigning an overloaded-operator result back to it all segfault. A class
// with only primitive (int) fields works fine (V below), so the trigger is
// specifically a *struct* used as a class field. This blocks modelling a
// mutable, shared object that contains value-typed sub-objects (e.g. a
// Budget holding a Money balance).

describe("struct-typed class field bug", () => {
	test("read struct field from main runs", async () => {
		const input = `
struct Money {
	var int cents
	func to_string = (self, out string) {
		return "\\{self.cents}"
	}
}
class Wallet {
	var Money funds
}
var Wallet w = Wallet(Money(777))
Console.write("\\{w.funds}")
`;
		await build_and_check_output(input, "class_struct_field_read_bug", "777");
	});

	test("copy struct field into local in method runs", async () => {
		const input = `
struct Money {
	var int cents
	func to_string = (self, out string) {
		return "\\{self.cents}"
	}
}
class Wallet {
	var Money funds = Money(0)
	func peek = (self) {
		var Money cur = self.funds
		Console.write("\\{cur}")
	}
}
var Wallet w = Wallet()
w.peek()
`;
		await build_and_check_output(input, "class_struct_field_copy_bug", "0");
	});

	test("overload result assigned to struct class field runs", async () => {
		const input = `
struct Money {
	var int cents
	func #op_add = (self, Money other, out Money) {
		return Money(self.cents + other.cents)
	}
	func to_string = (self, out string) {
		return "\\{self.cents}"
	}
}
class Wallet {
	var Money funds = Money(0)
	func add = (ref self, Money amount) {
		self.funds = self.funds + amount
	}
}
var Wallet w = Wallet()
w.add(Money(500))
Console.write("\\{w.funds}")
`;
		await build_and_check_output(input, "class_struct_field_overload_bug", "500");
	});

	test("class with only int field works (control)", async () => {
		const input = `
class Wallet {
	var int funds
}
var Wallet w = Wallet(777)
Console.write("\\{w.funds}")
`;
		await build_and_check_output(input, "class_int_field_control", "777");
	});
});
