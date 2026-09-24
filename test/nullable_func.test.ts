import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Nullable func types (`func?` / `Func<...>?`): a func binding that may hold
// `null`. A null func is represented by a zero word (C: a NULL closure
// descriptor pointer), so comparisons and stores need no new runtime; the
// checker gates USES of a null-tracked binding ("may be null") and `!= null`
// guards narrow it — the Nomen spelling of TS's optional callbacks
// (`closeNode?` / `closeNode?.()`).

function errors_of(input: string): string[] {
	return parse_with_imports(input).errors.map((e) => e.message);
}

describe("nullable func locals", () => {
	test("null default, guard, then assign and call", async () => {
		const input = `
func five = (out int) {
	return 5
}

var func? (out int) f = null
if f != null {
	Console.write("bad")
}
f = five
if f != null {
	Console.write(f().to_string())
}
`;
		await build_and_check_output(input, "nfunc_local_guard", "5");
	});

	test("Func<...>? alias spelling with a nullable func return", async () => {
		const input = `
func make = (out Func<int>?) {
	return null
}
var Func<int>? f = make()
if f == null {
	Console.write("null")
} else {
	Console.write("value")
}
`;
		await build_and_check_output(input, "nfunc_alias_return_null", "null");
	});

	test("assignment of null clears a previously set func", async () => {
		const input = `
func five = (out int) {
	return 5
}

var func? (out int) f = five
if f == null {
	Console.write("bad")
}
f = null
if f == null {
	Console.write("cleared")
}
`;
		await build_and_check_output(input, "nfunc_local_reset", "cleared");
	});
});

describe("nullable func parameters", () => {
	test("a real func and null both pass, guarded call inside", async () => {
		const input = `
func five = (out int) {
	return 5
}

func run = (func? (out int) f) {
	if f != null {
		Console.write(f().to_string())
	} else {
		Console.write("none")
	}
}

run(five)
run(null)
`;
		await build_and_check_output(input, "nfunc_param_both", "5none");
	});

	test("Func<...>? alias parameter with a lambda argument", async () => {
		const input = `
func run = (Func<int, void>? f) {
	if f != null {
		f(7)
	} else {
		Console.write("none")
	}
}

run(func (int x) { Console.write(x.to_string()) })
run(null)
`;
		await build_and_check_output(input, "nfunc_alias_param", "7none");
	});

	test("nested inside another signature", async () => {
		const input = `
func five = (out int) {
	return 5
}

func run = (func (func? (out int)) g) {
	g(five)
	g(null)
}

func callit = (func? (out int) f) {
	if f != null {
		Console.write(f().to_string())
	}
}

run(callit)
`;
		await build_and_check_output(input, "nfunc_nested_sig", "5");
	});
});

describe("nullable func fields", () => {
	test("class field with a null default, guarded call", async () => {
		const input = `
class Box {
	var func? (out int) cb = null
}

func five = (out int) {
	return 5
}

var Box b = Box()
if b.cb != null {
	Console.write("bad")
}
b.cb = five
if b.cb != null {
	Console.write(b.cb().to_string())
}
`;
		await build_and_check_output(input, "nfunc_field_class", "5");
	});

	test("value struct field with a null default", async () => {
		const input = `
struct S {
	var func? (out int) cb = null
}

func five = (out int) {
	return 5
}

var S s = S()
if s.cb != null {
	Console.write("bad")
}
s.cb = five
Console.write(s.cb().to_string())
`;
		await build_and_check_output(input, "nfunc_field_struct", "5");
	});

	test("method-side optional callback (the TS closeNode? shape)", async () => {
		const input = `
class Renderer {
	var func? (int) close_node = null
	var int closed = 0

	pub func close = (ref self, int node) {
		if self.close_node != null {
			self.close_node(node)
		}
		self.closed = 1
	}
}

var Renderer r = Renderer()
r.close(3)
Console.write(r.closed.to_string())
`;
		await build_and_check_output(input, "nfunc_field_method", "1");
	});
});

describe("nullable func errors", () => {
	test("calling a null-tracked func errors", () => {
		const msgs = errors_of(`
var func? (out int) f = null
f()
`);
		expect(msgs.some((m) => m.includes("may be null"))).toBe(true);
	});

	test("a guard narrows: only the unguarded call errors", () => {
		const msgs = errors_of(`
var func? (out int) f = null
f()
if f != null {
	f()
}
`);
		expect(msgs.some((m) => m.includes("may be null"))).toBe(true);
		expect(msgs.length).toBe(1);
	});

	test("null to a non-nullable func parameter errors", () => {
		const msgs = errors_of(`
func run = (func (out int) f) {
	f()
}
run(null)
`);
		expect(msgs.length).toBeGreaterThanOrEqual(1);
	});

	test("null to a non-nullable func local errors", () => {
		const msgs = errors_of(`
var func (out int) f = null
`);
		expect(msgs.some((m) => m.includes("func?"))).toBe(true);
	});
});
