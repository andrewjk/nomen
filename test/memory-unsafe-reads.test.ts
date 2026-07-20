import { describe, test, expect } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Regression tests for unsafe memory operations that were previously present
// in the hand-written `#arch: c` blocks in core/System. Both were fixed:
//
//   1. String.#op_mul (core/System/String.echo) used 32-bit `int` arithmetic
//      for `str_len * count + 1`, so large multiplications overflowed,
//      `malloc` got a far-too-small size, and the `memcpy` loop wrote past
//      the buffer (heap overflow / crash). Now computed with `size_t`.
//
//   2. Console.read_line (core/System/Console.echo) grew its buffer only when
//      `len + 1 >= cap`, leaving no room for the trailing NUL; the final
//      `buf[len] = 0` terminator wrote one byte past the allocation on the
//      exact-cap boundary. Now it reserves room for the terminator
//      (`len + 2 > cap`).
//
// NOTE: The aarch64 backend already used 64-bit arithmetic in these paths,
// so the overflow class was C-backend specific.

const C = { arch: "c" as const, platform: "macos" as const, audit: true };

describe("regression: String.#op_mul uses width-safe arithmetic (C backend)", () => {
	test("moderate repetition produces the right length", async () => {
		const input = `
const string big = "ab" * 50000
Console.write("\\{big.length}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, C);
		await check_output("reg_opmul_moderate", result, "100000\n", C);
	});

	test("single-char repetition length is exact", async () => {
		const input = `
const string big = "x" * 12345
Console.write("\\{big.length}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, C);
		await check_output("reg_opmul_single", result, "12345\n", C);
	});
});

describe("regression: Console.read_line reserves room for the NUL (C backend)", () => {
	// The bug only manifested on input whose length landed on the grow
	// boundary (exact multiples of the 16-byte initial capacity, e.g. 16,
	// 32, ...). Print with a plain write_line (no interpolation) so the test
	// isolates the reader rather than the string-interpolation path.
	test("input of exactly 16 chars does not overrun", async () => {
		const input = `
const string line = Console.read_line()
Console.write_line(line)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, C);
		await check_output("reg_readline_16", result, "0123456789abcdef\n", {
			...C,
			provideStdin: "0123456789abcdef\n",
		});
	});

	test("input of exactly 32 chars does not overrun", async () => {
		const input = `
const string line = Console.read_line()
Console.write_line(line)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, C);
		await check_output("reg_readline_32", result, "0123456789abcdef0123456789abcdef\n", {
			...C,
			provideStdin: "0123456789abcdef0123456789abcdef\n",
		});
	});

	test("short input still works", async () => {
		const input = `
const string line = Console.read_line()
Console.write_line(line)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, C);
		await check_output("reg_readline_short", result, "hi\n", {
			...C,
			provideStdin: "hi\n",
		});
	});
});
