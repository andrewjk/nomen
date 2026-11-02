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

	// Int64 constant folding beyond 2^53 (FOLLOWUP.md): the aarch64 backend's
	// literal-op fold computed in JS doubles — which round beyond 2^53 AND
	// whose String() prints ~17 significant digits — so
	// `-9223372036854775807 - 1` folded to the out-of-range literal
	// `-9223372036854776000` and ran as 9223372036854775616. The fold now
	// runs on BigInt (the int_literal.ts route) and wraps like the machine.
	describe("int64 constant folding precision", () => {
		test("INT64_MIN spelled -max - 1 folds exactly", async () => {
			const input = `
var int64 m = -9223372036854775807 - 1
Console.write("\\{m}")
`;
			await build_and_check_output(input, "int64_fold_int64_min", "-9223372036854775808");
		});

		test("0 - big folds exactly (the constant operand used to fold first)", async () => {
			const input = `
var int64 m = 0 - 9223372036854775807
Console.write("\\{m}")
`;
			await build_and_check_output(input, "int64_fold_zero_minus_big", "-9223372036854775807");
		});

		test("the positive max folds exactly", async () => {
			const input = `
var int64 m = 9223372036854775806 + 1
Console.write("\\{m}")
`;
			await build_and_check_output(input, "int64_fold_int64_max", "9223372036854775807");
		});

		test("an overflowing product wraps like the machine's mul", async () => {
			// 3037000500^2 = 9223372037000250000 > 2^63 — the 64-bit register
			// wraps it to -9223372036709301616, and so must the fold.
			const input = `
var int64 m = 3037000500 * 3037000500
Console.write("\\{m}")
`;
			await build_and_check_output(input, "int64_fold_mul_wrap", "-9223372036709301616");
		});

		test("a shift beyond int32 width folds at 64-bit like lsl", async () => {
			// The old fold shifted in JS int32 (`1 << 62` → 1 << 30); the
			// machine's `lsl` is 64-bit.
			const input = `
var int64 s = 1 << 62
Console.write("\\{s}")
`;
			await build_and_check_output(input, "int64_fold_shift64", "4611686018427387904");
		});

		test("signed division truncates toward zero", async () => {
			const input = `
var int64 q = -7 / 2
Console.write("\\{q}")
`;
			await build_and_check_output(input, "int64_fold_div_trunc", "-3");
		});
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

	// Large literals (>16 bits) cannot be encoded as a aarch64 `mv` (movz)
	// immediate and must lower to a `ldr =imm` literal-pool load. They must also
	// be emitted in decimal — the assembler rejects `#0x..`/`#0o..`/`#0b..`.
	// Regression for the FNV-1a prime `0x01000193` failing to assemble on the
	// aarch64 backend (`mov x2, #0x01000193` → "expected compatible register or
	// logical immediate").

	test("large hex as arithmetic operand", async () => {
		const input = `
const int h = 0x01000193 * 65536
Console.write("\\{h}")
`;
		await build_and_check_output(input, "int_lit_large_hex_operand", "1099538038784");
	});

	test("large hex operand against a variable (FNV-1a shape)", async () => {
		const input = `
func hash_step = (int h, out int) {
	return (h * 0x01000193) & 0xFFFFFFFF
}
Console.write("\\{hash_step(1)}")
`;
		await build_and_check_output(input, "int_lit_large_hex_var_operand", "16777619");
	});

	test("large hex as array literal element", async () => {
		const input = `
const int[] v = [0x01000193, 42]
Console.write("\\{v.at(0)}\\{v.at(1)}")
`;
		await build_and_check_output(input, "int_lit_large_hex_array", "1677761942");
	});

	test("large binary and octal operands", async () => {
		const input = `
const int b = 0b10000000000000000
const int o = 0o10
Console.write("\\{b * o}")
`;
		await build_and_check_output(input, "int_lit_large_bin_oct_operand", "524288");
	});
});
