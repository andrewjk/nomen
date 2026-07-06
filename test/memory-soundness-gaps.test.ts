import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
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
		// `cur` borrows a pointer the list exposes via .at(); assigning it to the
		// outer `cur` would outlive the list. Rejected (instance method return
		// is treated as a borrow of the receiver). (`.pop()` is now `mov out T` —
		// an owned return — so it can escape freely; `.at()` is the borrow case.)
		const input = `
class Animal { var char letter }
var Animal cur
if true {
    var List<Animal> list = List<Animal>()
    list.push(mov Animal('Z'))
    if list.length > 0 {
        cur = list.at(0)
    }
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
		await build_and_check_output(input, "defer_reassign_borrow", "1\n");
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
		// The replacement anchors in h's declaration frame, so it isn't freed
		// at each iteration's scope exit; h holds the last value (5), audit
		// balanced (old instances reclaimed at scope exit).
		await build_and_check_output(input, "defer_reassign_loop", "5\n");
	});
});

// Copying an owning struct out of a field (`var Own x = obj.field`) duplicates
// the backing pointer, so both the copy and the owner would free the same data
// (double-free). This is now caught: the copy is rejected unless the field is
// moved out with `mov` AND a `swap` that revalidates it
// (`var Own x = mov obj.field swap <replacement>`). The `swap` is mandatory for
// a field move because a field cannot be left holding a moved-out value -- the
// replacement is stored back in so the owner never destroys a moved field. (The
// `Map`/`Set` `rehash` functions use exactly this idiom.)
describe("owning-struct member-access copy", () => {
	test("member-access copy of an owning struct is rejected", () => {
		const input = `
struct Pair {
	var List<int> first = List<int>()
}
func take = (ref Pair p) {
	var List<int> leak = p.first
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("cannot copy"),
		);
	});

	test("member-access copy of an owning struct (Buffer) is rejected", () => {
		const input = `
struct Holder {
	var Buffer<int> buf = Buffer<int>()
}
func take = (ref Holder h) {
	var Buffer<int> leak = h.buf
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("cannot copy"),
		);
	});

	test("mov out of a field without a swap is rejected", () => {
		// `mov` alone would leave the field holding a moved-out (invalid) value.
		const input = `
struct Holder {
	var Buffer<int> buf = Buffer<int>()
}
func take = (ref Holder h) {
	var Buffer<int> leak = mov h.buf
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("requires a swap"),
		);
	});

	test("mov out of a field with a swap is allowed", () => {
		const input = `
struct Holder {
	var Buffer<int> buf = Buffer<int>()
}
func take = (ref Holder h) {
	var Buffer<int> old = mov h.buf swap Buffer<int>()
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});

// `mov` transfers ownership, so the source is invalidated and may not be used
// again until it is reassigned (or revalidated by a swap). This is enforced at
// compile time: a moved variable read afterward is a "used after move" error.
describe("use-after-move", () => {
	test("using a variable after it is moved out is rejected", () => {
		const input = `
var List<int> a = List<int>()
a.push(1)
var List<int> b = mov a
a.push(2)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after move"),
		);
	});

	test("a moved variable is revalidated by reassignment", () => {
		const input = `
var List<int> a = List<int>()
a.push(1)
var List<int> b = mov a
a = List<int>()
a.push(2)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});

// `b = mov a swap <replacement>` swaps an owning struct variable out: b takes
// a's value, and the replacement is struct-copied back into a (which is then
// un-marked moved, so it is destroyed normally). This mirrors the field-swap
// path used by Map/Set rehash.
describe("owning-struct variable swap", () => {
	test("swapping an owning-struct variable revalidates the source", async () => {
		const input = `
var List<int> a = List<int>()
a.push(1)
var List<int> b = List<int>()
b = mov a swap List<int>()
const int v = b.pop()
Console.write("\\{v}")
`;
		await build_and_check_output(input, "var_swap", "1");
	});
});
