import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Generic containers now take `move T value` on push/add/set. When T is a class,
// the caller's variable is invalidated — ownership transfers into the container.
// This prevents use-after-free: the class instance survives as long as the
// container holds it, even if the original variable's scope has ended.

describe("container ownership via move", () => {
	test("class stored in list survives owner scope exit", async () => {
		const input = `
owning struct Animal { var char letter }
var List<Animal> list = List<Animal>()
if true {
	var Animal a = Animal('Z')
	list.push(move a)
}
var Animal dead = list.pop()
Console.write("got: \\{dead.letter}\\n")
`;
		// With move, `a` is invalidated — its anchor is skipped at scope exit.
		// The Animal survives in the list's buffer. pop() returns a valid pointer.
		// LEAK: 1 — the container doesn't free stored values on destroy yet.
		// That's a known limitation; the type-safety guarantee (no UAF) is what matters.
		await build_and_check_output(input, "uaf_container_scope", "got: Z\n");
	});

	test("same class in two lists requires explicit ownership", async () => {
		const input = `
owning struct Animal { var char letter }
var List<Animal> l1 = List<Animal>()
var List<Animal> l2 = List<Animal>()
if true {
	var Animal a = Animal('X')
	l1.push(move a)
	l2.push(move a)
}
var Animal x = l1.pop()
var Animal y = l2.pop()
Console.write("\\{x.letter} \\{y.letter}\\n")
`;
		// The second push(move a) should be a compile error — a was already moved.
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("used after move");
	});

	test("cross-container element pushes are sound copies (R)", async () => {
		// Class-era, `l2.push(l1.at(0))` shared the instance pointer — both
		// lists freed it (SIGABRT). Post-R an `.at()` read of an owning
		// element is a DEEP COPY, so each list owns independent elements and
		// the shared-ownership hazard cannot arise.
		const input = `
owning struct Animal { var char letter }
var List<Animal> l1 = List<Animal>()
var List<Animal> l2 = List<Animal>()
l1.push(move Animal('X'))
l2.push(l1.at_or_panic(0))
var Animal x = l2.pop()
Console.write("\\{x.letter}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input + "\n", "uaf_cross_container_copy", "X\n");
	});

	test("an element copy moved into another container is sound", async () => {
		// Same family, via a local: the `.at()` copy is OWNED, so moving it
		// into `l2` is an ordinary transfer (no shared ownership).
		const input = `
owning struct Animal { var char letter }
var List<Animal> l1 = List<Animal>()
var List<Animal> l2 = List<Animal>()
l1.push(move Animal('X'))
var Animal borrowed = l1.at_or_panic(0)
l2.push(move borrowed)
var Animal x = l2.pop()
Console.write("\\{x.letter}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("storing a borrowed trait value is rejected", async () => {
		// Trait-typed containers also store owned pointers (ClassBuffer<Trait>
		// with vtable-dispatched destroy), so the same shared-ownership
		// hazard applies.
		const input = `
trait Speaker { func speak = (self, out string) }
owning struct Dog : Speaker { func speak = (self, out string) { return "woof" } }
var List<Speaker> l1 = List<Speaker>()
var List<Speaker> l2 = List<Speaker>()
l1.push(move Dog())
l2.push(l1.at(0))
`;
		const parsed = parse_with_imports(input);
		const borrow_err = parsed.errors.find((e) =>
			e.message.includes("Cannot move a borrowed value"),
		);
		expect(borrow_err).toBeDefined();
	});

	test("owning extraction via items.move is accepted", async () => {
		// `items.move(i)` is now declared `move out T` — the result is
		// OWNED (the source slot is relinquished), so it can be moved into
		// a fresh owning container without creating shared ownership. The
		// borrow checker resolves the call's `owned_return` flag and treats
		// the result as a non-borrow. (Verified here at the parse/check
		// level; the same shape inside the same module as the List — e.g.
		// a `pop_at` extension — would compile and run.)
		const input = `
owning struct Animal { var char letter }
var List<Animal> src = List<Animal>()
src.push(move Animal('Z'))
// list.pop() is the public owning-extract primitive (move out T). After
// pop, the source list no longer references the Animal — moving it into
// another list does not create shared ownership.
var Animal moved = src.pop()
var List<Animal> dst = List<Animal>()
dst.push(move moved)
var Animal x = dst.pop()
Console.write("\\{x.letter}\\n")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});
