import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

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

	test("a captured scalar works as a method receiver", async () => {
		// Regression: address-taking paths (method receivers) must read through
		// the env, not fall back to a data label (see emit_var_address).
		await build_and_check_output(
			`
import System

pub func main = () {
	var int n = 7
	var func (out string) show = (out string) => n.to_string()
	Console.write("\\{show()}")
}
`,
			"lambda_capture_receiver",
			"7",
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

describe("closure captures (owned strings)", () => {
	test("a lambda captures a string by deep copy", async () => {
		await build_and_check_output(
			`
import System

pub func main = () {
	var string greeting = "hi"
	var func (string, out string) decorate = (s, out string) => s + " " + greeting
	var string r = decorate("yo")
	Console.write("\\{r}")
}
`,
			"lambda_capture_string",
			"yo hi",
			true,
		);
	});

	test("captured strings and scalars mix, even through a method receiver", async () => {
		// `n.to_string()` takes the captured scalar as a method RECEIVER — the
		// address-taking path that used to bypass the capture env on aarch64.
		await build_and_check_output(
			`
import System

pub func main = () {
	var int n = 1
	var string tag = "a"
	var func (out string) show = (out string) => tag + n.to_string()
	n = 9
	tag = "z"
	Console.write("\\{show()} \\{show()}")
}
`,
			"lambda_capture_string_mix",
			"a1 a1",
			true,
		);
	});
});

describe("closure captures (value structs)", () => {
	test("a non-owning struct captures by copy (snapshot)", async () => {
		await build_and_check_output(
			`
import System

struct Point {
	var int x
	var int y
}

pub func main = () {
	var Point p = Point(1, 2)
	var func (out int) total = (out int) => p.x + p.y
	p.x = 99
	Console.write("\\{total()} \\{total()}")
}
`,
			"lambda_capture_struct",
			"3 3",
			true,
		);
	});

	test("a captured struct works as a method receiver", async () => {
		await build_and_check_output(
			`
import System

struct Point {
	var int x
	var int y

	func sum = (self, out int) => self.x + self.y
}

pub func main = () {
	var Point p = Point(4, 5)
	var func (out int) total = (out int) => p.sum()
	Console.write("\\{total()}")
}
`,
			"lambda_capture_struct_method",
			"9",
			true,
		);
	});
});

describe("closure captures (owning structs & classes, move)", () => {
	test("a lambda moves an owning struct into its env", async () => {
		await build_and_check_output(
			`
import System

struct Owned {
	var List<int> data
}

pub func main = () {
	var Owned o = Owned(List<int>())
	o.data.push(7)
	var func (out int) first = (out int) => o.data.at_or(0, -1)
	Console.write("\\{first()} \\{first()}")
}
`,
			"lambda_capture_owning_struct",
			"7 7",
			true,
		);
	});

	test("a lambda moves a class instance into its env", async () => {
		await build_and_check_output(
			`
import System

class Box {
	var int v = 0
}

pub func main = () {
	var Box b = Box()
	b.v = 5
	var func (out int) get = (out int) => b.v
	Console.write("\\{get()}")
}
`,
			"lambda_capture_class",
			"5",
			true,
		);
	});

	test("move-capturing an owning struct invalidates the donor", () => {
		expect(
			parse_with_imports(`
struct Owned {
	var List<int> data
}

var Owned o = Owned(List<int>())
var func (out int) first = (out int) => o.data.at(0)
Console.write("\\{o.data.length} \\{first()}")
`).errors.some((m) => m.message.includes("used after move")),
		).toBe(true);
	});
});

describe("closure captures (nested closures)", () => {
	test("a lambda captures another capturing lambda by move", async () => {
		await build_and_check_output(
			`
import System

pub func main = () {
	var int base = 3
	var func (out int) inner = (out int) => base + 1
	var func (out int) outer = (out int) => inner() + 1
	Console.write("\\{outer()} \\{outer()}")
}
`,
			"lambda_capture_nested_closure",
			"5 5",
			true,
		);
	});
});
