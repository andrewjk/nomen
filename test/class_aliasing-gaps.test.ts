import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

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

// Reassigning an object-level alias ADOPTS the assignment into the alias's
// own slot (the checker clears the alias link; the slot becomes an owning
// var). The previously-aliased instance stays owned by its owner; the
// adopted instance is anchored and freed at scope exit. (Pre-Phase-A this
// shape rode the runtime `alias_owns` flag machinery; Phase A blocked it as
// "incoherent"; the instance-alias reading — owner reassignment already
// leaves the alias on the old instance — makes adoption sound without that
// machinery.)
describe("class aliasing: alias reassignment adopts (§A3.2, amended)", () => {
	test("reassigning a ref alias adopts the fresh instance", async () => {
		const input = `
mv struct R {
	var int v
}
var Box<R> p = Box<R>(R(1))
ref Box<R> q = p
q = Box<R>(R(3))
Console.write("\\{p.v} \\{q.v}")
`;
		await build_and_check_output(input, "alias_adopt_single", "1 3");
	});

	test("every alias reassignment re-points; the owner keeps its instance", async () => {
		const input = `
mv struct R {
	var int v
}
var Box<R> p = Box<R>(R(1))
ref Box<R> q = p
q = Box<R>(R(3))
q = Box<R>(R(4))
Console.write("\\{p.v} \\{q.v}")
`;
		await build_and_check_output(input, "alias_adopt_double", "1 4");
	});

	// Post-adoption, `q` is an ordinary owning var — a `mv` transfer out of it
	// is expressible and must move the adopted instance (leaving `q` moved-out,
	// the owner untouched, and the audit balanced).
	test("a transferred adopted instance moves with mv (both backends)", async () => {
		const input = `
mv struct R {
	var int v
}
var Box<R> p = Box<R>(R(1))
ref Box<R> q = p
q = Box<R>(R(3))
mv Box<R> x = mv q
Console.write("\\{p.v} \\{x.v}")
`;
		await build_and_check_output(input, "alias_adopt_mv_transfer", "1 3");
	});
});

// Loop reclamation. Constructor reassignment with no live reference reclaims
// the old instance eagerly each iteration (the owner test above PASSES).
// An *alias* reassigned in a loop adopts each fresh instance; displaced
// adoptions are reclaimed (with their `#destroy`) at scope exit.
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

	test("alias reassignment in a loop adopts and reclaims (§A3.2, amended)", async () => {
		const input = `
mv struct R {
	var int v
	func #destroy = () {
		self.v = 0
	}
}
var Box<R> p = Box<R>(R(0))
ref Box<R> q = p
var int i = 0
while i < 3 {
	q = Box<R>(R(i))
	i = i + 1
}
Console.write("\\{q.v}\\n")
`;
		await build_and_check_output(input, "alias_adopt_loop_destroy", "2\n");
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
