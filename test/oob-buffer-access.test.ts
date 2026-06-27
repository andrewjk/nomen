import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Buffer bounds checking: load_int/store_int clamp the index to [0, cap-1]
// at runtime. Negative constant indices are also caught at compile time via
// the `i >= 0` constraint. Out-of-range reads return 0; out-of-range writes
// are silently ignored. This prevents heap corruption without runtime aborts.

describe("buffer bounds checking", () => {
	test("negative constant index is caught at compile time", () => {
		const input = `
var Buffer buf = Buffer()
buf.grow_int(4)
buf.store_int(0, 111)
var int neg = buf.load_int(-1)
Console.write("\\{neg}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("constraint");
	});

	test("index past capacity returns 0 (clamped at runtime)", async () => {
		const input = `
var Buffer buf = Buffer()
buf.grow_int(4)
buf.store_int(0, 111)
var int past = buf.load_int(100)
Console.write("past=\\{past}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		// Index 100 is clamped to cap-1=3. buf[3] was zeroed by grow_int → 0.
		await check_output("oob_read_positive", result, "past=0\n");
	});

	test("write past capacity is clamped to last valid index", async () => {
		const input = `
var Buffer buf = Buffer()
buf.grow_int(2)
buf.store_int(0, 11)
buf.store_int(1, 22)
buf.store_int(5, 999)
var int a = buf.load_int(0)
var int b = buf.load_int(1)
var int c = buf.load_int(2)
var int d = buf.load_int(3)
Console.write("\\{a} \\{b} \\{c} \\{d}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		// grow_int(2) rounds up to cap=4. store_int(5, 999) clamps to
		// index 3 (cap-1). data = [11, 22, 0, 999]. No crash, no corruption.
		await check_output("oob_write_positive", result, "11 22 0 999\n");
	});
});
