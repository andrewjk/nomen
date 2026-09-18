import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// Closure captures (docs/CLOSURE_PLAN.md Phase 2a): a lambda may capture outer
// SCALARS by copy. The value site heap-allocates an env struct (one 8-byte
// field per capture) and a heap descriptor; the holder (a func-typed local)
// frees both at scope exit (audit-balanced). Strings/owning values/classes and
// non-scalar captures are follow-ups.

describe("closure captures (scalars)", () => {
	test("a declaration-lambda captures a scalar and reads it on each call", async () => {
		await build_and_check_output(
			`
import System

pub func main = () {
	var int base = 10
	var func (int, out int) add_base = (x, out int) => x + base
	Console.write("\\{add_base(1)} \\{add_base(2)}")
}
`,
			"lambda_capture_scalar",
			"11 12",
			true,
		);
	});

	test("a zero-arg lambda captures two scalars", async () => {
		await build_and_check_output(
			`
import System

pub func main = () {
	var int a = 1
	var int b = 2
	var func (out int) sum = (out int) => a + b
	Console.write("\\{sum()} \\{sum()}")
}
`,
			"lambda_capture_two",
			"3 3",
			true,
		);
	});

	test("the capture is a snapshot — later writes to the source are not seen", async () => {
		await build_and_check_output(
			`
import System

pub func main = () {
	var int n = 5
	var func (out int) get = (out int) => n
	n = 99
	Console.write("\\{get()}")
}
`,
			"lambda_capture_snapshot",
			"5",
			true,
		);
	});
});

describe("closure capture rejections", () => {
	function errors(input: string): string[] {
		return parse_raw(input).errors.map((e) => e.message);
	}

	test("capturing a string is rejected", () => {
		expect(
			errors(`
import System

pub func main = () {
	var string s = "hi"
	var func (out int) len = (out int) => s.length
	Console.write("\\{len()}")
}
`).some((m) => m.includes("Cannot capture 's' in a closure")),
		).toBe(true);
	});

	test("capturing a struct is rejected", () => {
		expect(
			errors(`
import System

struct Pt {
	var int x
}

pub func main = () {
	var Pt p = Pt(1)
	var func (out int) get = (out int) => p.x
	Console.write("\\{get()}")
}
`).some((m) => m.includes("Cannot capture 'p' in a closure")),
		).toBe(true);
	});

	test("capturing a class is rejected", () => {
		expect(
			errors(`
import System

class Box {
	var int v = 0
}

pub func main = () {
	var Box b = Box()
	var func (out int) get = (out int) => b.v
	Console.write("\\{get()}")
}
`).some((m) => m.includes("Cannot capture 'b' in a closure")),
		).toBe(true);
	});
});
