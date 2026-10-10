import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// Generic enums monomorphized with a CLASS or TRAIT element type. The case
// payload of such a mono rides as a `struct Tag *` (a class instance is a
// heap reference; a by-value field would need the full typedef before the
// enum's header block and would byte-copy the instance). Ownership follows
// the single-ownership container contract: case construction TAKES the
// instance (fresh constructions transfer; owned locals are moved
// implicitly), and the enum value's scope exit destroys + frees the
// payload. A borrowed argument is rejected at check time.

describe("generic enum with class/trait payloads", () => {
	test("Option<Box> fresh construction, match, field access (both backends)", async () => {
		const input = `
import System

mv struct Box {
	pub var int v = 0
	pub func #init = (ref self, int v) {
		self.v = v
	}
}

pub func main = (Init init) {
	var Option<Box> o = Option.some(Box(42))
	Console.write_line(match o {
		case .some(b) -> b.v.to_string()
		case .none -> "missing"
	})
	var Option<Box> n = Option<Box>.none
	Console.write_line(match n {
		case .some(b) -> b.v.to_string()
		case .none -> "missing"
	})
}
`;
		await build_and_check_output(input, "generic_enum_class_payload", "42\nmissing", true);
	});

	test("Option<Trait> mv construction, match, vtable dispatch (both backends)", async () => {
		const input = `
import System

trait Animal {
	pub func legs = (self, out int)
}

mv struct Dog : Animal {
	pub func legs = (self, out int) {
		return 4
	}
}

pub func main = (Init init) {
	var Dog d = Dog()
	var Option<Animal> o = Option.some(mv d)
	var int n = match o {
		case .some(a) -> a.legs()
	} else -> 0
	Console.write_line(n.to_string())
	var Option<Animal> e = Option<Animal>.none
	var int m = match e {
		case .some(a) -> a.legs()
	} else -> 0
	Console.write_line(m.to_string())
}
`;
		await build_and_check_output(input, "generic_enum_trait_payload", "4\n0", true);
	});

	// A fresh-constructor argument (not a moved local) must also be boxed into
	// the trait payload — the constructor result is materialized directly in
	// the heap box, so the enum's scope-exit free reclaims a heap instance
	// (not the constructor's stack temporary).
	test("Option<Trait> fresh-constructor payload (both backends)", async () => {
		const input = `
import System

trait Animal {
	pub func legs = (self, out int)
}

mv struct Dog : Animal {
	pub var int n = 0
	pub func #init = (ref self, int n) {
		self.n = n
	}
	pub func legs = (self, out int) {
		return self.n
	}
}

pub func main = (Init init) {
	var Option<Animal> o = Option.some(Dog(4))
	var int n = match o {
		case .some(a) -> a.legs()
	} else -> 0
	Console.write_line(n.to_string())
	var Option<Animal> p = Option<Animal>.some(Dog(9))
	var int m = match p {
		case .some(a) -> a.legs()
	} else -> 0
	Console.write_line(m.to_string())
}
`;
		await build_and_check_output(input, "generic_enum_trait_ctor_payload", "4\n9", true);
	});

	// A string-field conformer: the mv transfers its (uniformly heap) string
	// to the box, so the box owns it and no copy is orphaned (LEAK). The case
	// method returns an int (a string-returning dispatch inside a match has a
	// separate pre-existing C leak — see FOLLOWUP.md).
	test("Option<Trait> string-field conformer payload (both backends)", async () => {
		const input = `
import System

trait Counter {
	pub func count = (self, out int)
}

mv struct Tally : Counter {
	pub var string label
	pub func count = (self, out int) {
		return 3
	}
}

pub func main = (Init init) {
	var Tally t = Tally("hi")
	var Option<Counter> o = Option.some(mv t)
	Console.write_line(match o {
		case .some(a) -> a.count().to_string()
	} else -> "0")
	var Option<Counter> p = Option.some(Tally("yo"))
	Console.write_line(match p {
		case .some(a) -> a.count().to_string()
	} else -> "0")
}
`;
		await build_and_check_output(input, "generic_enum_trait_str_payload", "3\n3", true);
	});

	// A trait-dispatched `string` method bound in a match case returns an OWNED
	// heap copy (the conformer's return boundary strdups the literal). The
	// binding's mv wrapper must free it — it previously leaked on C.
	test("Option<Trait> string-returning dispatch in a match binding (both backends)", async () => {
		const input = `
import System

trait Speaker {
	pub func speak = (self, out string)
}

mv struct Named : Speaker {
	pub func speak = (self, out string) {
		return "spoke"
	}
}

pub func main = (Init init) {
	var Named n = Named()
	var Option<Speaker> o = Option.some(mv n)
	Console.write_line(match o {
		case .some(a) -> a.speak()
	} else -> "?")
}
`;
		await build_and_check_output(input, "generic_enum_trait_str_return_match", "spoke", true);
	});

	test("owned local transfers implicitly and stays sound (both backends)", async () => {
		const input = `
import System

mv struct Box {
	pub var int v = 0
	pub func #init = (ref self, int v) {
		self.v = v
	}
}

pub func main = (Init init) {
	var Box b = Box(7)
	var Option<Box> o = Option.some(b)
	Console.write_line("owned")
}
`;
		await build_and_check_output(input, "generic_enum_class_owned_local", "owned", true);
	});

	test("borrowed value into a case payload is rejected", () => {
		const input = `
import System

mv struct Box {
	pub var int v = 0
}

struct Host {
	var Box item
	pub func #init = (ref self, Box b) {
		self.item = b
	}
	pub func maybe = (self, out Option<Box>) {
		return Option.some(self.item)
	}
}

pub func main = (Init init) {
	var Host h = Host(Box(5))
	var Option<Box> o = h.maybe()
	Console.write_line("unreachable")
}
`;
		const parsed = parse_raw(input);
		// Post-R the payload is a mv STRUCT — a bare field read is a
		// copy of the field's owned state, rejected like the declaration
		// side's copy rule.
		expect(parsed.errors.some((e) => e.message.includes("cannot pass a field read to case"))).toBe(
			true,
		);
	});
});
