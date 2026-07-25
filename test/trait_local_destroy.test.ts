import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Milestone: trait-typed destroy propagation for LOCAL variables. A local
// declared with a trait type but concrete storage (e.g. `var Speaker s =
// Dog("Rex")`) must run the concrete struct's #destroy (and reclaim owned
// fields) at scope exit. Previously the auto-free pass looked up
// `dec.type.name` (the trait) in `status.structs`, found nothing, and
// silently skipped the local — leaking owned heap data and dropping #destroy
// side effects.

describe("trait-typed local destroy (scope-exit propagation)", () => {
	test("struct #destroy runs when trait-typed local goes out of scope", async () => {
		const input = `
trait Speaker { func speak = (self, out string) }

struct Dog : Speaker {
	var string name
	func speak = (self, out string) { return self.name }
	func #destroy = (ref self) {
		Console.write("destroying " + self.name)
	}
}

if true {
	var Speaker s = Dog("Rex")
	Console.write(s.speak())
}
Console.write("\\ndone")
`;
		// The trait-typed local `s` has concrete `struct Dog` storage. At
		// scope exit, Dog_destroy(&s) must run (printing "destroying Rex")
		// before the frame is popped. Note: s.speak() has no trailing
		// newline, so "destroying" follows immediately after "Rex".
		await build_and_check_output(input, "trait_local_destroy", "Rexdestroying Rex\ndone");
	});

	test("trait-typed local without user #destroy still reclaims owned fields", async () => {
		// Dog has no user #destroy, but its `string name` field is owned heap
		// data. With audit on, this would leak without destroy propagation
		// through the trait view.
		const input = `
trait Speaker { func speak = (self, out string) }

struct Dog : Speaker {
	var string name
	func speak = (self, out string) { return self.name }
}

if true {
	var Speaker s = Dog("Rex")
	Console.write(s.speak())
}
Console.write("\\ndone")
`;
		await build_and_check_output(input, "trait_local_auto_destroy", "Rex\ndone");
	});

	test("trait-typed local of struct with multiple owning fields", async () => {
		// Dog owns two string fields. Both must be reclaimed at scope exit
		// (audit on) — the trait view must walk the concrete struct's fields.
		const input = `
trait Speaker { func speak = (self, out string) }

struct Dog : Speaker {
	var string name
	var string title
	func speak = (self, out string) { return self.title }
}

if true {
	var Speaker s = Dog("Rex", "Good")
	Console.write(s.speak())
}
Console.write("\\ndone")
`;
		await build_and_check_output(input, "trait_local_multi_field", "Good\ndone");
	});
});
