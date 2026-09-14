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

class Box {
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

	test("Option<Trait> move construction, match, vtable dispatch (both backends)", async () => {
		const input = `
import System

trait Animal {
	pub func legs = (self, out int)
}

class Dog : Animal {
	pub func legs = (self, out int) {
		return 4
	}
}

pub func main = (Init init) {
	var Dog d = Dog()
	var Option<Animal> o = Option.some(move d)
	var int n = match o {
		case .some(a) -> a.legs()
		else -> 0
	}
	Console.write_line(n.to_string())
	var Option<Animal> e = Option<Animal>.none
	var int m = match e {
		case .some(a) -> a.legs()
		else -> 0
	}
	Console.write_line(m.to_string())
}
`;
		await build_and_check_output(input, "generic_enum_trait_payload", "4\n0", true);
	});

	test("owned local transfers implicitly and stays sound (both backends)", async () => {
		const input = `
import System

class Box {
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

class Box {
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
		expect(parsed.errors.some((e) => e.message.includes("case payload takes ownership"))).toBe(
			true,
		);
	});
});
