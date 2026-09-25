import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("lambda assignment to func variables", () => {
	test("slot form: lambda assigned over null default", async () => {
		const input = `
var func? (out int) f = null
f = () => 6
if f != null {
	Console.write(f().to_string())
}
`;
		await build_and_check_output(input, "lambda_assign_null_slot", "6");
	});

	test("slot form: lambda assigned over named function", async () => {
		const input = `
func five = (out int) {
	return 5
}
var func (out int) f = five
Console.write(f().to_string())
f = () => 6
Console.write(f().to_string())
`;
		await build_and_check_output(input, "lambda_assign_named_slot", "56");
	});

	test("repeated lambda assignment to the same slot", async () => {
		const input = `
var func? (out int) f = null
f = () => 1
Console.write(f().to_string())
f = () => 2
Console.write(f().to_string())
`;
		await build_and_check_output(input, "lambda_assign_repeated", "12");
	});

	test("field target: lambda assigned to a func field", async () => {
		const input = `
class Box {
	var func? (out int) cb = null
}
var Box b = Box()
b.cb = () => 7
if b.cb != null {
	Console.write(b.cb().to_string())
}
`;
		await build_and_check_output(input, "lambda_assign_class_field", "7");
	});

	test("params slot reassigned from named to lambda (control)", async () => {
		const input = `
func twice = (int x, out int) {
	return x * 2
}
var func (int, out int) g = twice
Console.write(g(3).to_string())
g = (x) => x * 3
Console.write(g(3).to_string())
`;
		await build_and_check_output(input, "lambda_assign_params_control", "69");
	});
});
