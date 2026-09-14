import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// A method may return a CLASS borrow rooted at `self` — the call site re-roots
// the result at the receiver argument (the same convention as `view T`
// returns), so accessor methods like `state.nodes.at_or_panic(i)` are sound
// and no longer need the "cannot return a borrowed reference" workaround.

describe("self-rooted borrowed returns", () => {
	test("accessor method returns a borrowed class element", async () => {
		const input = `
import System

class Node {
	pub var string name

	pub func #init = (ref self) {
		self.name = "" + ""
	}
}

class Nodes {
	pub var List<Node> items = List<Node>()

	pub func #init = (ref self) {
	}

	pub func node = (self, int i, out Node) {
		return self.items.at_or_panic(i)
	}
}

pub func main = (Init init) {
	var ns = Nodes()
	ns.items.push(Node())
	ns.items.push(Node())
	var Node first = ns.node(0)
	first.name = "first"
	var Node second = ns.node(1)
	second.name = "second"
	Console.write("\\{ns.node(0).name} \\{ns.node(1).name}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "borrowed_accessor_return", "first second\ndone\n", true);
	});

	test("accessor method returns a borrowed class FIELD", async () => {
		const input = `
import System

class Box {
	pub var int v
}

class Holder {
	pub move Box b

	pub func get = (self, out Box) {
		return self.b
	}
}

pub func main = (Init init) {
	var h = Holder(move Box(9))
	var Box got = h.get()
	Console.write("v=\\{got.v}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "borrowed_field_return", "v=9\ndone\n", true);
	});

	test("borrow returned from a NON-self root is still rejected", async () => {
		const input = `
import System

class Node {
	pub var string name

	pub func #init = (ref self) {
		self.name = "" + ""
	}
}

func leak = (ref List<Node> items, out Node) {
	return items.at_or_panic(0)
}

pub func main = (Init init) {
	var items = List<Node>()
	items.push(Node())
	var Node n = leak(ref items)
	Console.write("\\{n.name}\\n")
}
`;
		const parsed = parse_raw(input);
		expect(
			parsed.errors.some((e) => e.message.includes("cannot return a borrowed reference")),
		).toBe(true);
	});
});
