import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A `ref` TRAIT param is passed the ADDRESS of the caller's boxed-handle slot
// (`void **` on C; a saved &slot on aarch64 — a trait local stores a heap
// handle whose first word is the conformer's vtable). The callee's
// reassignment boxes the new conformer, reclaims the displaced handle through
// the trait's `<Trait>_destroy` shim, and swaps the handle through the slot;
// reads through the param deref to the instance. These tests pin the
// write-back, the reads on both sides of it, and the displaced-instance
// reclaim (audit on catches a double-free or a leak).
describe("ref trait param reassignment", () => {
	test("reassign across conformers, caller sees the new conformer", async () => {
		const input = `
trait Speaker {
	func speak = (self, out string)
}

mv struct Dog: Speaker {
	var string name
	func speak = (self, out string) {
		return "woof"
	}
}

mv struct Cat: Speaker {
	func speak = (self, out string) {
		return "meow"
	}
}

func retype = (ref Speaker sp) {
	sp = Cat()
}

var Speaker s = Dog("Rex")
Console.write(s.speak())
retype(ref s)
Console.write(s.speak())`;
		await build_and_check_output(input, "ref_trait_retype", "woofmeow");
	});

	test("reads through the ref param on both sides of the reassignment", async () => {
		const input = `
trait Speaker {
	func speak = (self, out string)
}

mv struct Dog: Speaker {
	var string name
	func speak = (self, out string) {
		return "woof"
	}
}

mv struct Cat: Speaker {
	func speak = (self, out string) {
		return "meow"
	}
}

func probe = (ref Speaker sp, out string) {
	var string before = sp.speak()
	sp = Cat()
	var string after = sp.speak()
	return before + "/" + after
}

var Speaker s = Dog("Rex")
Console.write(probe(ref s))
Console.write("|")
Console.write(s.speak())`;
		await build_and_check_output(input, "ref_trait_probe", "woof/meow|meow");
	});

	test("boxed value-struct conformers retype through the ref param", async () => {
		const input = `
trait Rule {
	func test = (self, string line, out bool)
}

struct HeadingV: Rule {
	pub func test = (self, string line, out bool) {
		return line.at_or(0, ' ') == '#'
	}
}

struct QuoteV: Rule {
	pub func test = (self, string line, out bool) {
		return line.at_or(0, ' ') == '>'
	}
}

func retype = (ref Rule r) {
	r = QuoteV()
}

var Rule r = HeadingV()
if r.test("# h") {
	Console.write("heading")
} else {
	Console.write("other")
}
retype(ref r)
if r.test("# h") {
	Console.write("heading")
} else {
	Console.write("other")
}`;
		await build_and_check_output(input, "ref_trait_value_struct", "headingother");
	});

	test("reassign twice — the displaced handle is reclaimed each time", async () => {
		const input = `
trait Speaker {
	func speak = (self, out string)
}

mv struct Dog: Speaker {
	func speak = (self, out string) {
		return "woof"
	}
}

mv struct Cat: Speaker {
	func speak = (self, out string) {
		return "meow"
	}
}

func retype = (ref Speaker sp, bool to_cat) {
	if to_cat {
		sp = Cat()
	} else {
		sp = Dog()
	}
}

var Speaker s = Dog()
retype(ref s, true)
Console.write(s.speak())
retype(ref s, false)
Console.write(s.speak())
retype(ref s, true)
Console.write(s.speak())`;
		await build_and_check_output(input, "ref_trait_retype_twice", "meowwoofmeow");
	});

	test("ref mv-struct param reassignment reclaims the displaced instance", async () => {
		const input = `
mv struct Dog {
	var string name = "rex"
	func speak = (self, out string) {
		return "woof"
	}
}

func replace = (ref Dog d) {
	d = Dog()
}

var Dog s = Dog()
Console.write(s.speak())
replace(ref s)
Console.write(s.speak())`;
		await build_and_check_output(input, "ref_mv_struct_retype", "woofwoof");
	});
});
