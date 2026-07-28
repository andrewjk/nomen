import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Trait-typed retrieval from a `ClassBuffer<Trait>`: a trait-typed local
// whose initializer is a method-call return (e.g. `var Speaker p =
// pets.at(i)`), not a constructor. The ClassBuffer<Trait> slot already
// stores a correct vtable-bearing class pointer; the gap was that the
// trait-typed-local storage path only recognised constructor
// initializers, so a method-call return fell through and got no usable
// storage. Now the local holds the returned pointer, dispatches through
// the trait vtable, and follows the callee's ownership convention:
// `.at` borrows (not freed — the container owns the element), while a
// `mov out T` method like `pop` transfers ownership (freed at scope
// exit).

describe("Trait-typed retrieval from ClassBuffer<Trait>", () => {
	test("retrieve via .at and dispatch (borrow — not freed)", async () => {
		const input = `
trait Speaker { func speak = (self, out string) }
class Dog : Speaker {
	var string name
	func speak = (self, out string) { return self.name }
	func #destroy = (ref self) {
		Console.write("destroying " + self.name)
	}
}

if true {
	var List<Speaker> pets = List<Speaker>()
	pets.push(mov Dog("Rex"))
	for i of 0 .. pets.length {
		var Speaker p = pets.at(i)
		Console.write(p.speak())
	}
}
Console.write("\\ndone")
`;
		// p borrows the element from pets, so it must NOT be freed at
		// scope exit — pets owns it and frees it once on its own destroy
		// (no double-free, audit balances). Dispatch routes p.speak()
		// through the Speaker vtable to Dog.speak → "Rex".
		await build_and_check_output(input, "cb_trait_retrieve_at", "Rexdestroying Rex\ndone");
	});

	test("retrieve via pop (mov out — owned, freed at scope exit)", async () => {
		const input = `
trait Speaker { func speak = (self, out string) }
class Dog : Speaker {
	var string name
	func speak = (self, out string) { return self.name }
	func #destroy = (ref self) {
		Console.write("destroying " + self.name)
	}
}

if true {
	var List<Speaker> pets = List<Speaker>()
	pets.push(mov Dog("Rex"))
	var Speaker p = pets.pop()
	Console.write(p.speak())
}
Console.write("\\ndone")
`;
		// pop() is `mov out T`, so ownership transfers to p. p is freed
		// at scope exit via the trait's Speaker_destroy shim (→
		// Dog_destroy → "destroying Rex"). pets' slot was nulled by
		// move_int, so no double-free.
		await build_and_check_output(input, "cb_trait_retrieve_pop", "Rexdestroying Rex\ndone");
	});

	test("heterogeneous retrieval dispatches each concrete type", async () => {
		const input = `
trait Speaker { func speak = (self, out string) }
class Dog : Speaker {
	var string name
	func speak = (self, out string) { return self.name }
}
class Cat : Speaker {
	var string name
	func speak = (self, out string) { return self.name }
}

if true {
	var List<Speaker> pets = List<Speaker>()
	pets.push(mov Dog("dog Rex"))
	pets.push(mov Cat("cat Tom"))
	for i of 0 .. pets.length {
		var Speaker p = pets.at(i)
		Console.write(p.speak())
	}
}
Console.write("\\ndone")
`;
		// Both conformers share an identical speak (return self.name); the
		// point is that each retrieval dispatches through the Speaker
		// vtable to the correct concrete type (Dog vs Cat) — verified by
		// the distinct names stuffed in at construction.
		await build_and_check_output(input, "cb_trait_retrieve_hetero", "dog Rexcat Tom\ndone");
	});
});
