import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Borrowed class references (from a field access, a function return, or an
// intermediate variable) have no lifetime tracking. They can outlive the
// instance that owns them, so once the owner is freed the borrow dangles — a
// use-after-free. The direct assignment `b = h.c` is rejected, but indirect
// paths bypass it.
//
// The SAME-SCOPE reassignment case is now handled by deferred reclamation
// (see "borrowed reference kept valid across owner reassignment" below): the
// old instance is freed at scope exit, not at reassignment, so a borrow in the
// same scope stays valid. The remaining gaps are CROSS-SCOPE — the borrow
// escapes to a scope that outlives the owner. These still compile cleanly and
// dangle at runtime; the assertions below FAIL today.

describe("borrowed-reference lifetime gaps (cross-scope use-after-free)", () => {
	test("borrowed field via intermediate variable outlives owner scope", () => {
		// `tmp` borrows p.a; `stolen = tmp` smuggles it out. p dies at the
		// if-exit, leaving `stolen` dangling (UAF / crash).
		const input = `
class Box { var int v }
class Pair {
    mov Box a
    mov Box b
}
var Box stolen = Box(0)
if true {
    var Pair p = Pair(mov Box(1), mov Box(2))
    var Box tmp = p.a
    stolen = tmp
}
Console.write("\\{stolen.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("function returning a borrowed field escapes the owner", () => {
		// getc returns h.c (a borrow). The caller keeps `b` past the scope
		// where the owner `h` lives, so `b` dangles (UAF / crash).
		const input = `
class Box { var int v }
class Holder { mov Box c }
func getc = (ref Holder h, out Box) {
    return h.c
}
var Box b = Box(0)
if true {
    var Holder h = Holder(mov Box(5))
    b = getc(ref h)
}
Console.write("\\{b.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("container element borrow outlives the container", () => {
		// `cur` borrows a pointer the list stores; when the list dies its
		// buffer is freed and `cur` dangles.
		const input = `
class Animal { var char letter }
var Animal cur
if true {
    var List<Animal> list = List<Animal>()
    list.push(mov Animal('Z'))
    cur = list.pop()
}
Console.write("\\{cur.letter}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("class reassignment inside a loop frees the live instance each iteration", () => {
		// Distinct pre-existing bug: re-anchoring on `h = Holder(...)` adds the
		// new anchor to the loop-body frame, so it is freed at each iteration's
		// scope exit — leaving `h` dangling for the next iteration and after the
		// loop. Compiles clean; crashes / UAF at runtime.
		const input = `
class Box { var int v }
class Holder { mov Box c }
var Holder h = Holder(mov Box(0))
var int i = 1
while i <= 5 {
    var Box tmp = Box(i)
    h = Holder(mov tmp)
    i = i + 1
}
Console.write("\\{h.c.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});
});

// Regression coverage for the case that IS now handled: a borrowed field stays
// valid across reassignment of its owner, because the owner's old instance is
// freed at scope exit (deferred reclamation), not at the reassignment.

describe("deferred reclamation across owner reassignment", () => {
	test("borrowed reference kept valid across owner reassignment", async () => {
		const input = `
class Box { var int v }
class Holder { mov Box c }
var Holder h = Holder(mov Box(1))
var Box b = h.c
h = Holder(mov Box(2))
Console.write("\\{b.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		// b still aliases Box(1); h's reassignment no longer frees it eagerly,
		// so this reads 1 (not the reused Box(2) pointer) with no leak.
		await check_output("defer_reassign_borrow", result, "1\n", { audit: true });
	});
});
