import { describe, test, expect } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Failing tests for a type-mismatch bug in string interpolation on the C
// backend.
//
// `src/build_c/build_root_node.ts` emits `_string_interpolate_N` with every
// argument typed `char *argN` and a `%s` format. But Echo lets you
// interpolate non-string values (e.g. an `int` field/method result) directly
// into a string literal — `"...\{some_int}..."`. The compiler is supposed to
// convert that int to its string form first. When it doesn't, the C helper
// receives a 4-byte `int` where it expects an 8-byte `char *`, reads past the
// actual argument (and treats the int bits as a pointer), and crashes
// (SIGABRT / segfault) at the `snprintf`. This is an unsafe read driven by a
// bad cast/ABI mismatch in the generated code.
//
// (The aarch64 backend builds the interpolated string via _snprintf with
// correct per-argument handling, so this is C-backend specific.)

const C = { arch: "c" as const, platform: "macos" as const, audit: true };

describe("unsafe: string interpolation of a non-string value (C backend)", () => {
	test("interpolating an int field crashes (reads int as char*)", async () => {
		const input = `
const string other = "after"
Console.write_line("\\{other.length} \\{other}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, C);
		await check_output("unsafe_interp_int_field", result, "5 after\n", C);
	});

	test("interpolating an int variable crashes", async () => {
		const input = `
const int n = 42
const string other = "x"
Console.write_line("\\{n} \\{other}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, C);
		await check_output("unsafe_interp_int_var", result, "42 x\n", C);
	});

	test("interpolating an int method result crashes", async () => {
		const input = `
const string line = "hello"
const string other = "x"
Console.write_line("\\{line.length} \\{other}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, C);
		await check_output("unsafe_interp_int_method", result, "5 x\n", C);
	});
});
