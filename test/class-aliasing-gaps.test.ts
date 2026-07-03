import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Classes are reference types: `var Box q = p` is documented to create a shared
// reference (MEMORY.md §Classes). Such an object-level alias must NOT be
// destroyed/freed at scope exit — the original declaration is the sole owner —
// but it must also stay valid across mutations of the owner (p and q are the
// same object). The build classifies a plain class-variable copy as a non-owning
// alias (like a field borrow) so #destroy/free runs exactly once, without
// tripping the child-group borrow-invalidation machinery; and reassigning an
// alias to a fresh instance transfers ownership to it (the shared old value is
// left untouched, the new instance is destroyed once at exit). These are
// regression tests for that behaviour. Reassignment of a class instance is now
// reclaimed eagerly when no live reference (field/method borrow or object alias)
// keeps the old value alive — which is what makes constructor reassignment sound
// inside a loop (the emitted code frees the current instance each iteration
// instead of deferring to a single scope-exit slot that gets overwritten). When
// a reference does exist, the old value is deferred as before. Remaining loop
// gaps: reassignment via a factory call or a ref param, and an *alias*
// reassigned in a loop (its ownership is gained at runtime, which the build
// can't see statically) — see the final describe block.

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

// Reassigning an object-level alias to a fresh instance transfers ownership to
// the alias: the shared old value is left for its original owner to reclaim, and
// the new instance is anchored in the alias's declaration frame and flagged to
// run #destroy at scope exit (the alias is not in scoped_declarations, so its
// destroy can't go through that path). Regression tests for that behaviour.
describe("class aliasing: reassigning an alias to a fresh instance", () => {
	test("reassigning an alias does not destroy the shared old instance", async () => {
		const input = `
class R {
	var int v
	func #destroy = () {
		Console.write("[D\\{self.v}]")
	}
}
var R p = R(1)
var R q = p
q = R(3)
Console.write("done\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		// No destroy fires on the reassignment; R(1) and R(3) each destroy once
		// at scope exit (p owns R(1), q owns R(3)).
		await check_output("alias_reassign_leak", result, "done\n");
	});

	test("repeated reassignment destroys each former instance once", async () => {
		const input = `
class R {
	var int v
	func #destroy = () {
		self.v = 0
	}
}
var R p = R(1)
var R q = p
q = R(3)
q = R(4)
Console.write("done\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		// R(1) (p), R(3) (q's first), R(4) (q's second) each reclaimed exactly
		// once — no leak, no double free (audit balanced).
		await check_output("alias_reassign_twice", result, "done\n");
	});
});

// Loop reclamation. Constructor reassignment with no live reference now reclaims
// the old instance eagerly each iteration (the owner test below PASSES). An
// *alias* reassigned in a loop still leaks: an alias only becomes the owner of
// its value at runtime (after its first reassignment), which the build can't see
// statically, so it never takes the eager path. (Factory-call and ref-param
// reassignment in a loop are separate paths with the same shape — tracked in
// reassignment-loop.test.ts.)
describe("class reassignment in a loop", () => {
	test("owner reassigned in a loop reclaims every former instance", async () => {
		const input = `
class R {
	var int v
	func #destroy = () {
		self.v = 0
	}
}
var R p = R(0)
var int i = 0
while i < 3 {
	p = R(i)
	i = i + 1
}
Console.write("\\{p.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("loop_reassign_owner", result, "2\n");
	});

	test("alias reassigned in a loop reclaims every former instance", async () => {
		const input = `
class R {
	var int v
	func #destroy = () {
		self.v = 0
	}
}
var R p = R(0)
var R q = p
var int i = 0
while i < 3 {
	q = R(i)
	i = i + 1
}
Console.write("\\{q.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("loop_reassign_alias", result, "2\n");
	});
});
