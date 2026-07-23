import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Hex (0x), octal (0o), and binary (0b) integer literals. These tests compile
// and run the program on BOTH the C and aarch64 backends, verifying the
// emitted code produces the correct runtime value.

describe("integer literal bases", () => {
	test("hex literal equals decimal value", async () => {
		const input = `
const int hex = 0xFF
Console.write("\\{hex}")
`;
		await build_and_check_output(input, "int_lit_hex_eq", "255");
	});

	test("octal literal equals decimal value", async () => {
		const input = `
const int oct = 0o377
Console.write("\\{oct}")
`;
		await build_and_check_output(input, "int_lit_oct_eq", "255");
	});

	test("binary literal equals decimal value", async () => {
		const input = `
const int bin = 0b11111111
Console.write("\\{bin}")
`;
		await build_and_check_output(input, "int_lit_bin_eq", "255");
	});

	test("all three bases print identically", async () => {
		const input = `
const int a = 0xFF
const int b = 0o377
const int c = 0b11111111
Console.write("\\{a}\\{b}\\{c}")
`;
		await build_and_check_output(input, "int_lit_all_eq", "255255255");
	});

	test("hex literal value prints", async () => {
		const input = `
const int x = 0xCAFE
Console.write("\\{x}")
`;
		await build_and_check_output(input, "int_lit_hex_value", "51966");
	});

	test("case-insensitive prefixes", async () => {
		const input = `
const int a = 0Xff
const int b = 0O377
const int c = 0B1010
Console.write("\\{a}\\{b}\\{c}")
`;
		await build_and_check_output(input, "int_lit_uppercase", "25525510");
	});

	test("underscore digit separators are ignored", async () => {
		const input = `
const int grouped = 0xCAFE_F00D
Console.write("\\{grouped}")
`;
		await build_and_check_output(input, "int_lit_hex_underscores", "3405705229");
	});

	test("decimal underscores", async () => {
		const input = `
const int n = 1_000_000
Console.write("\\{n}")
`;
		await build_and_check_output(input, "int_lit_decimal_underscores", "1000000");
	});

	test("type inference without annotation", async () => {
		const input = `
const x = 0xFF
const y = 0o77
const z = 0b1010
Console.write("\\{x}\\{y}\\{z}")
`;
		await build_and_check_output(input, "int_lit_inferred", "2556310");
	});

	test("coerce to uint8", async () => {
		const input = `
const uint8 byte = 0xFF
Console.write("\\{byte}")
`;
		await build_and_check_output(input, "int_lit_coerce_uint8", "255");
	});

	test("bitwise ops with hex literals", async () => {
		const input = `
const int mask = 0xF0
const int value = 0x3C
const int result = (mask & value) | 0x01
Console.write("\\{result}")
`;
		await build_and_check_output(input, "int_lit_bitwise", "49");
	});

	test("hex literal used in arithmetic", async () => {
		const input = `
const int base = 0x10
const int result = base * 2 + 0xF
Console.write("\\{result}")
`;
		await build_and_check_output(input, "int_lit_arith", "47");
	});

	test("large hex literal (max int32)", async () => {
		const input = `
const int big = 0x7FFFFFFF
Console.write("\\{big}")
`;
		await build_and_check_output(input, "int_lit_large", "2147483647");
	});

	test("int64 to_string with hex literal", async () => {
		const input = `
const int64 big = 0x100000000
Console.write("\\{big}")
`;
		await build_and_check_output(input, "int_lit_int64", "4294967296");
	});

	test("uint64 to_string with hex literal", async () => {
		const input = `
const uint64 big = 0xFFFFFFFFFFFFFFFF
Console.write("\\{big}")
`;
		await build_and_check_output(input, "int_lit_uint64", "18446744073709551615");
	});

	test("signed hex literal", async () => {
		const input = `
const int neg = -0xFF
Console.write("\\{neg}")
`;
		await build_and_check_output(input, "int_lit_signed_hex", "-255");
	});

	test("literals in arrays", async () => {
		const input = `
const int[] codes = [0xFF, 0o377, 0b1010]
Console.write("\\{codes.at(0)}\\{codes.at(1)}\\{codes.at(2)}")
`;
		await build_and_check_output(input, "int_lit_array", "25525510");
	});
});
