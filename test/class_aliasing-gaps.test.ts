import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

const system = get_library(path.resolve("core"));

function check(source: string) {
	return parse(source, system, undefined, { allow_internal: true }).errors;
}

// Classes are reference types: an object-level alias (`ref Box q = p`,
// STRUCT_PLAN_3 Phase A) must NOT be destroyed/freed at scope exit — the
// original declaration is the sole owner — but it must also stay valid across
// mutations of the owner (p and q are the same object). The build classifies a
// spelled class-variable alias as a non-mv alias (like a field borrow) so
// #destroy/free runs exactly once, without tripping the child-group
// borrow-invalidation machinery. Reassignment of a class instance is reclaimed
// eagerly when no live reference (field/method borrow or object alias) keeps
// the old value alive — which is what makes constructor reassignment sound
// inside a loop (the emitted code frees the current instance each iteration
// instead of deferring to a single scope-exit slot that gets overwritten). When
// a reference does exist, the old value is deferred as before. Rebinding an
// ALIAS is rejected at check time (§A3.2) — see the describes below.

describe("class aliasing: double destroy / double free", () => {
	// #1 — `ref R q = p` aliases the same instance. At scope exit the compiler
	// emits a `R_destroy` call for *both* p and q, so a user `#destroy`'s side
	// effects run twice (here "DD" instead of "D"). The underlying `free()`
	// runs only once, so the audit count stays balanced — the bug is purely the
	// duplicated destructor, which the prefix-mismatch catches.
	test("aliased local runs #destroy twice", async () => {
		const input = `
mv struct R {
	var int v
	func #destroy = () {
		Console.write("D")
	}
}
if true {
	var Box<R> p = Box<R>(R(1))
	ref Box<R> q = p
}
Console.write("done\\n")
`;
		await build_and_check_output(input, "alias_double_destroy", "Ddone\n");
	});

	// #2 — A class that owns another class (`mv Inner c`) is aliased. Both
	// aliases' destroy paths `free()` the inner instance, so the inner is freed
	// twice → double free → the process aborts. Correct behaviour is to print
	// the value with no crash and a balanced audit.
	test("aliased class with a class field double-frees the inner", async () => {
		const input = `
mv struct Inner {
	var int v
}
mv struct Outer {
	var Inner c
}
var Box<Outer> p = Box<Outer>(Outer(mv Inner(7)))
ref Box<Outer> q = p
Console.write("\\{p.c.v}\\n")
`;
		await build_and_check_output(input, "alias_double_free_inner", "7\n");
	});

	// #3 — The double-destroy compounds across loop iterations: each iteration
	// allocates one instance but the alias causes #destroy to fire twice per
	// iteration, so two iterations print "DDDD" instead of "DD". On a workload
	// that allocates in a loop this silently doubles every destructor side effect.
	test("aliased class in a loop double-destroys each iteration", async () => {
		const input = `
mv struct R {
	var int v
	func #destroy = () {
		Console.write("D")
	}
}
var int i = 0
while i < 2 {
	var Box<R> p = Box<R>(R(i))
	ref Box<R> q = p
	i = i + 1
}
Console.write("done\\n")
`;
		await build_and_check_output(input, "alias_loop_double_destroy", "DDdone\n");
	});
});

// Reassigning an object-level alias to a fresh instance used to transfer
// ownership to the alias (the runtime `alias_owns` flag machinery). STRUCT_PLAN_3
// Phase A §A3.2 rejects alias rebinds outright — a `ref` is "another name for it,
// for this scope", a const pointer; re-pointing an alias under deferred-free
// semantics is where the model becomes incoherent. These tests pin the error.
describe("class aliasing: reassigning an alias is an error (§A3.2)", () => {
	test("reassigning a ref alias is rejected", () => {
		const input = `
import System
mv struct R {
	var int v
}
var Box<R> p = Box<R>(R(1))
ref Box<R> q = p
q = Box<R>(R(3))
`;
		const expected = [test_error(input, "'q' is a ref — reassign the owner, not the alias", 8, 1)];
		expect(check(input)).toEqual(expected);
	});

	test("every alias reassignment is rejected", () => {
		const input = `
import System
mv struct R {
	var int v
}
var Box<R> p = Box<R>(R(1))
ref Box<R> q = p
q = Box<R>(R(3))
q = Box<R>(R(4))
`;
		const expected = [
			test_error(input, "'q' is a ref — reassign the owner, not the alias", 8, 1),
			test_error(input, "'q' is a ref — reassign the owner, not the alias", 9, 1),
		];
		expect(check(input)).toEqual(expected);
	});
});

// Loop reclamation. Constructor reassignment with no live reference reclaims
// the old instance eagerly each iteration (the owner test below PASSES).
// An *alias* reassigned in a loop is rejected by §A3.2 like any other rebind.
describe("class reassignment in a loop", () => {
	test("owner reassigned in a loop reclaims every former instance", async () => {
		const input = `
mv struct R {
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
		await build_and_check_output(input, "loop_reassign_owner", "2\n");
	});

	test("alias reassignment in a loop is rejected (§A3.2)", () => {
		const input = `
import System
mv struct R {
	var int v
}
var Box<R> p = Box<R>(R(0))
ref Box<R> q = p
var int i = 0
while i < 3 {
	q = Box<R>(R(i))
	i = i + 1
}
`;
		const expected = [test_error(input, "'q' is a ref — reassign the owner, not the alias", 10, 2)];
		expect(check(input)).toEqual(expected);
	});
});

describe("borrowed alias reassigned from another borrow stays a borrow", () => {
	// `var Node n = store.at(i)` re-roots as a borrow of the container's
	// element. Re-assigning from ANOTHER borrow (`n = store.at(j)`) must not
	// flip the alias to owned — the scope-exit destroy/free would reclaim
	// the container's live element (use-after-free at the next read).
	test("re-borrow keeps the alias non-mv (C + aarch64)", async () => {
		const input = `
import System

pub mv struct Node {
	pub var int v
}

pub mv struct Store {
	var List<Box<Node>> items = List<Box<Node>>()

	pub func add = (self, mv Box<Node> n) {
		self.items.push(mv n)
	}

	pub func at = (self, int i, out Box<Node>) {
		return self.items.at_or_panic(i)
	}
}

pub func main = (Init init) {
	var Store s = Store()
	s.add(Box<Node>(Node(7)))
	s.add(Box<Node>(Node(9)))
	var Box<Node> n = s.at(0)
	Console.write("\\{n.v}")
	n = s.at(1)
	Console.write(" \\{n.v}")
	Console.write_line("")
}
`;
		await build_and_check_output(input, "alias_reborrow_stays_borrow", "7 9\n", true, {
			audit: true,
		});
	});
});
