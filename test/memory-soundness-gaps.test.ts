import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Borrowed class references (from a field access, an intermediate variable, or
// a function return) are now lifetime-checked: a borrow defaults to staying in
// the scope it was taken in, and escaping it (assigning to an outer-scope
// variable, or returning it) is rejected at compile time. To extract ownership
// the user must use `mov` (with swap).

describe("borrow-escape rejection (caught at compile time)", () => {
	test("direct field-access assignment requires mov/swap", () => {
		const input = `
class Box { var int v }
class Holder { mov Box c }
var Holder h = Holder(mov Box(1))
var Box b = Box(0)
b = h.c
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("use mov with swap"))).toBe(true);
	});

	test("borrowed field via intermediate variable cannot escape its scope", () => {
		// `tmp` borrows p.a inside the if-block; assigning it to the outer
		// `stolen` would let it outlive p. Rejected.
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
		expect(parsed.errors.some((e) => e.message.includes("borrow escapes"))).toBe(true);
	});

	test("returning a borrowed field is rejected", () => {
		// getc returns h.c (a borrow); the caller could keep it past h's
		// lifetime. Rejected — use mov to transfer ownership.
		const input = `
class Box { var int v }
class Holder { mov Box c }
func getc = (ref Holder h, out Box) {
    return h.c
}
pub func main = () {
    var Box b = Box(0)
    if true {
        var Holder h = Holder(mov Box(5))
        b = getc(ref h)
    }
    Console.write("\\{b.v}\\n")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("borrowed reference"))).toBe(true);
	});

	test("in-scope borrow is allowed (no escape)", () => {
		// `b` borrows h.c and is used within the same scope — fine.
		const input = `
class Box { var int v }
class Holder { mov Box c }
var Holder h = Holder(mov Box(1))
var Box b = h.c
Console.write("\\{b.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("container element borrow cannot escape the container's scope", () => {
		// `cur` borrows a pointer the list stores via pop(); assigning it to the
		// outer `cur` would outlive the list. Rejected (instance method return
		// is treated as a borrow of the receiver).
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
		expect(parsed.errors.some((e) => e.message.includes("borrow escapes"))).toBe(true);
	});

	test("constructor and static factory returns are owned (escapable)", () => {
		// Fresh allocations from constructors / static factories are owned, not
		// borrows, so assigning them across scopes is fine.
		const input = `
class Box { var int v }
func mk = (out Box) {
    return Box(7)
}
var Box b
if true {
    b = mk()
}
Console.write("\\{b.v}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});

// Same-scope owner reassignment is sound via deferred reclamation: the old
// instance is freed at scope exit, not at the reassignment, so a borrow in the
// same scope stays valid. The replacement is anchored in the variable's
// declaration frame, so reassigning inside a nested scope (e.g. a loop body)
// does not free the live instance each iteration.

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
		await check_output("defer_reassign_borrow", result, "1\n", { audit: true });
	});

	test("class reassignment inside a loop keeps the live instance", async () => {
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
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		// The replacement anchors in h's declaration frame, so it isn't freed
		// at each iteration's scope exit; h holds the last value (5), audit
		// balanced (old instances reclaimed at scope exit).
		await check_output("defer_reassign_loop", result, "5\n", { audit: true });
	});
});
