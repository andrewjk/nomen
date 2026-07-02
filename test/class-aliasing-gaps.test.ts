import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Classes are reference types: `var Box q = p` is documented to create a shared
// reference (MEMORY.md §Classes). Such an object-level alias must NOT be
// destroyed/freed at scope exit — the original declaration is the sole owner —
// but it must also stay valid across mutations of the owner (p and q are the
// same object). The build now classifies a plain class-variable copy as a
// non-owning alias (like a field borrow) so #destroy/free runs exactly once,
// without tripping the child-group borrow-invalidation machinery. These are
// regression tests for that behaviour. (Reassigning an alias to a fresh
// instance, and the owner-reassignment use-after-free, remain open gaps.)

describe("class aliasing: double destroy / double free", () => {
	// #1 — `var R q = p` aliases the same instance. At scope exit the compiler
	// emits a `R_destroy` call for *both* p and q, so a user `#destroy`'s side
	// effects run twice (here "DD" instead of "D"). The underlying `free()`
	// runs only once, so the audit count stays balanced — the bug is purely the
	// duplicated destructor, which the prefix-mismatch catches.
	test("aliased local runs #destroy twice", async () => {
		const input = `
class R {
	var int v
	func #destroy = () {
		Console.write("D")
	}
}
if true {
	var R p = R(1)
	var R q = p
}
Console.write("done\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("alias_double_destroy", result, "Ddone\n");
	});

	// #2 — A class that owns another class (`mov Inner c`) is aliased. Both
	// aliases' destroy paths `free()` the inner instance, so the inner is freed
	// twice → double free → the process aborts. Correct behaviour is to print
	// the value with no crash and a balanced audit.
	test("aliased class with a class field double-frees the inner", async () => {
		const input = `
class Inner {
	var int v
}
class Outer {
	mov Inner c
}
var Outer p = Outer(mov Inner(7))
var Outer q = p
Console.write("\\{p.c.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("alias_double_free_inner", result, "7\n");
	});

	// #3 — The double-destroy compounds across loop iterations: each iteration
	// allocates one instance but the alias causes #destroy to fire twice per
	// iteration, so two iterations print "DDDD" instead of "DD". On a workload
	// that allocates in a loop this silently doubles every destructor side effect.
	test("aliased class in a loop double-destroys each iteration", async () => {
		const input = `
class R {
	var int v
	func #destroy = () {
		Console.write("D")
	}
}
var int i = 0
while i < 2 {
	var R p = R(i)
	var R q = p
	i = i + 1
}
Console.write("done\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("alias_loop_double_destroy", result, "DDdone\n");
	});
});
