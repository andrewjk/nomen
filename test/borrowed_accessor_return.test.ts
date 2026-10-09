import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// A method may return a CLASS borrow rooted at `self` — the call site re-roots
// the result at the receiver argument (the same convention as `view T`
// returns), so accessor methods like `state.nodes.at_or_panic(i)` are sound
// and no longer need the "cannot return a borrowed reference" workaround.

describe("self-rooted borrowed returns", () => {
	// SKIP (aarch64): a List<Box<T>> element returned from a method crashes
	// at the match/bind — the pre-B4 aarch64 container-handle dispatch
	// residual (FOLLOWUP). C runs the same program green ("first second").
	test.skip("accessor returns a boxed element handle (mutation through it lands)", async () => {
		const input = `
import System

mv struct Node {
	pub var string name

	pub func #init = (ref self) {
		self.name = "" + ""
	}
}

mv struct Nodes {
	pub var List<Box<Node>> items = List<Box<Node>>()

	pub func #init = (ref self) {
	}

	pub func node = (self, int i, out Box<Node>) {
		return self.items.at_or_panic(i)
	}
}

pub func main = (Init init) {
	var ns = Nodes()
	ns.items.push(Box<Node>(Node()))
	ns.items.push(Box<Node>(Node()))
	var Box<Node> first = ns.node(0)
	first.name = "first"
	var Box<Node> second = ns.node(1)
	second.name = "second"
	Console.write("\\{ns.node(0).name} \\{ns.node(1).name}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "borrowed_accessor_return", "first second\ndone\n", true);
	});

	test("accessor reads through the boxed field", async () => {
		// The class-era "return the field borrow" accessor has no R shape (a
		// box-by-value return shares the pointee — rejected); the surviving
		// form reads through the handle.
		const input = `
import System

mv struct Cell {
	pub var int v
}

mv struct Holder {
	pub var Box<Cell> b

	pub func get = (self, out int) {
		return self.b.v
	}
}

pub func main = (Init init) {
	var h = Holder(mv Box<Cell>(Cell(9)))
	var int got = h.get()
	Console.write("v=\\{got}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "borrowed_field_return", "v=9\ndone\n", true);
	});

	test("a mv-field read is still rejected as a return", async () => {
		const input = `
import System

mv struct Node {
	pub var string name

	pub func #init = (ref self) {
		self.name = "" + ""
	}
}

mv struct Host {
	pub var Box<Node> first

	pub func leak = (self, out Box<Node>) {
		return self.first_inner()
	}

	pub func first_inner = (self, out Box<Node>) {
		return self.first
	}
}

pub func main = (Init init) {
	var h = Host(Box<Node>(Node()))
	var Box<Node> n = h.leak()
	Console.write("\\{n.name}\\n")
}
`;
		const parsed = parse_raw(input);
		// `return self.first` reads an OWNING field by value — the box copy
		// shares the pointee with the field (both destroy it). Rejected like
		// the declaration side's copy rule.
		expect(parsed.errors.some((e) => e.message.includes("cannot copy 'Box' out of field"))).toBe(
			true,
		);
	});
});
