import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

// BUILD
describe("cast build", () => {
	test("int8 to int widening", async () => {
		const input = `
var int8 x = 5
var int y = x as int
Console.write("\\{y}")
`;
		await build_and_check_output(input, "cast_int8_int", "5");
	});

	test("uint8 to int widening", async () => {
		const input = `
var uint8 x = 200
var int y = x as int
Console.write("\\{y}")
`;
		await build_and_check_output(input, "cast_uint8_int", "200");
	});

	test("int to int8 truncation", async () => {
		const input = `
var int x = 258
var int8 y = x as int8
Console.write("\\{y}")
`;
		await build_and_check_output(input, "cast_int_int8", "2");
	});

	test("int to uint8 truncation", async () => {
		const input = `
var int x = 300
var uint8 y = x as uint8
Console.write("\\{y}")
`;
		await build_and_check_output(input, "cast_int_uint8", "44");
	});

	test("int16 to int widening", async () => {
		const input = `
var int16 x = 1000
var int y = x as int
Console.write("\\{y}")
`;
		await build_and_check_output(input, "cast_int16_int", "1000");
	});

	test("same type cast is no-op", async () => {
		const input = `
var int x = 42
var int y = x as int
Console.write("\\{y}")
`;
		await build_and_check_output(input, "cast_same_type", "42");
	});

	test("cast in expression", async () => {
		const input = `
var int8 x = 10
var int y = (x as int) + 5
Console.write("\\{y}")
`;
		await build_and_check_output(input, "cast_in_expr", "15");
	});

	test("cast with declaration value", async () => {
		const input = `
var int8 x = 100
const y = x as int
Console.write("\\{y}")
`;
		await build_and_check_output(input, "cast_decl_value", "100");
	});

	test("uint to int cast", async () => {
		const input = `
var uint x = 42
var int y = x as int
Console.write("\\{y}")
`;
		await build_and_check_output(input, "cast_uint_int", "42");
	});

	test("int8 negative widening", async () => {
		const input = `
var int8 x = -1
var int y = x as int
Console.write("\\{y}")
`;
		await build_and_check_output(input, "cast_int8_neg", "-1");
	});

	test("cast in function", async () => {
		const input = `
func convert = (int8 val, out int) {
	return val as int
}
var int8 x = 7
const y = convert(x)
Console.write("\\{y}")
`;
		await build_and_check_output(input, "cast_in_func", "7");
	});

	test("chained cast", async () => {
		const input = `
var int8 x = 5
var int y = x as int
var int z2 = y as int
Console.write("\\{z2}")
`;
		await build_and_check_output(input, "cast_chained", "5");
	});
});

// ERRORS
describe("cast errors", () => {
	test("cannot cast string to int", () => {
		const input = `
func test = (out int) {
	const x = "hello"
	const y = x as int
	return 0
}
`;
		const expected = [test_error(input, "Cannot cast from string to int", 4, 12)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("cannot cast int to string", () => {
		const input = `
func test = (out int) {
	const x = 5
	const y = x as string
	return 0
}
`;
		const expected = [test_error(input, "Cannot cast from int to string", 4, 12)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("cannot cast bool to string", () => {
		const input = `
func test = (out int) {
	const x = true
	const y = x as string
	return 0
}
`;
		const expected = [test_error(input, "Cannot cast from bool to string", 4, 12)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
