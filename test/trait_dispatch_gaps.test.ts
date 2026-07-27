import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// These tests cover the two former "remaining dispatch limitations":
//
// 1. Trait-typed local reassignment to a different concrete type
//    (`var Speaker s = Dog(); s = Cat()`). Reassignment between two different
//    conformers requires pointer (reference) storage, since the concrete
//    layouts differ. The supported polymorphic path is `class` conformers
//    (value structs are stack-stored and can't be reassigned across types
//    without boxing, which was removed).
//
// 2. Multi-word struct trait field access through dispatch. A trait field
//    whose type is a struct wider than one word must be copied in full by the
//    generated get/set accessors, not just the first 8 bytes.

describe("trait dispatch limitations (now fixed)", () => {
	test("reassign trait-typed local to a different concrete class", async () => {
		const input = `
trait Speaker {
	func speak = (self, out string)
}

class Dog: Speaker {
	func speak = (self, out string) {
		return "woof"
	}
}

class Cat: Speaker {
	func speak = (self, out string) {
		return "meow"
	}
}

var Speaker s = Dog()
Console.write(s.speak())
Console.write("\\n")
s = Cat()
Console.write(s.speak())
`;
		await build_and_check_output(input, "trait_local_reassign", "woof\nmeow");
	});

	test("reassign trait-typed local through a function that takes the trait", async () => {
		// A trait-typed local handed to a free function, then reassigned to a
		// second conformer and handed again. Exercises both dispatch and the
		// pointer-stored local surviving across reassignment.
		const input = `
trait Speaker {
	func speak = (self, out string)
}

class Dog: Speaker {
	func speak = (self, out string) { return "woof" }
}

class Cat: Speaker {
	func speak = (self, out string) { return "meow" }
}

func describe = (Speaker s, out string) {
	return s.speak()
}

var Speaker s = Dog()
Console.write(describe(s))
Console.write("\\n")
s = Cat()
Console.write(describe(s))
`;
		await build_and_check_output(input, "trait_local_reassign_fn", "woof\nmeow");
	});

	test("multi-word struct trait field read through trait-typed variable", async () => {
		// `Point` is a two-word struct (x + y), used as a trait field. Reading
		// `p.pos` through a trait-typed receiver must copy both words. Mirrors
		// the single-word `Named.name` case but with a multi-word field type.
		const input = `
struct Point {
	var int x
	var int y
}

trait Located {
	var Point pos
}

struct Marker: Located {
	var Point pos = Point(7, 9)
}

const Located p = Marker()
var Point where = p.pos
Console.write("\\{where.x},\\{where.y}")
`;
		await build_and_check_output(input, "trait_field_multiword_read", "7,9");
	});

	test("multi-word struct trait field written through trait-typed variable", async () => {
		// Writing a multi-word struct field through a trait-typed receiver
		// must copy the full value via the generated set accessor (not just
		// the first word).
		const input = `
struct Point {
	var int x
	var int y
}

trait Located {
	var Point pos
}

struct Marker: Located {
	var Point pos = Point(0, 0)
}

var Located p = Marker()
p.pos = Point(9, 8)
var Point where = p.pos
Console.write("\\{where.x},\\{where.y}")
`;
		await build_and_check_output(input, "trait_field_multiword_write", "9,8");
	});
});
