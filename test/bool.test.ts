import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("bool build", () => {
	test("const bool true in if", async () => {
		const input = `
const bool flag = true
var int result = 0
if flag {
	result = 1
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "bool_const_true", "1");
	});

	test("const bool false in if", async () => {
		const input = `
const bool flag = false
var int result = 0
if flag {
	result = 1
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "bool_const_false", "0");
	});

	test("comparison result stored in const bool", async () => {
		const input = `
const int x = 5
const bool flag = x > 3
var int result = 0
if flag {
	result = 1
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "bool_cmp_stored", "1");
	});

	test("comparison false stored in const bool", async () => {
		const input = `
const int x = 2
const bool flag = x > 3
var int result = 0
if flag {
	result = 1
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "bool_cmp_false_stored", "0");
	});

	test("bool passed to function", async () => {
		const input = `
func check = (bool flag, out int) {
	if flag {
		return 1
	}
	return 0
}

const bool flag = true
const result = check(flag)
Console.write("\\{result}")
`;
		await build_and_check_output(input, "bool_func_param", "1");
	});

	test("bool from comparison in function return", async () => {
		const input = `
func is_positive = (int x, out bool) {
	return x > 0
}

const bool result = is_positive(5)
var int output = 0
if result {
	output = 1
}
Console.write("\\{output}")
`;
		await build_and_check_output(input, "bool_func_return", "1");
	});

	test("negated bool", async () => {
		const input = `
const bool flag = true
var int result = 0
if !flag {
	result = 1
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "bool_negated", "0");
	});

	test("negated function call result (if !f(...))", async () => {
		const input = `
func is_even = (int n, out bool) {
	return n % 2 == 0
}
var int result = 0
if !is_even(3) {
	result = 1
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "bool_negated_call", "1");
	});

	test("negated method call result", async () => {
		const input = `
class Box {
	var bool on

	func get = (self, out bool) {
		return self.on
	}
}
const Box b = Box(true)
var int result = 0
if !b.get() {
	result = 1
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "bool_negated_method", "0");
	});

	test("negated field access", async () => {
		const input = `
class Box {
	var bool on
}
const Box b = Box(false)
var int result = 0
if !b.on {
	result = 1
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "bool_negated_field", "1");
	});

	test("bool equality comparison", async () => {
		const input = `
const bool a = true
const bool b = true
var int result = 0
if a == b {
	result = 1
}
Console.write("\\{result}")
`;
		await build_and_check_output(input, "bool_equality", "1");
	});
});
