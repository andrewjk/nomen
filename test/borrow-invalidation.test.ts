import { describe, expect, test } from "vite-plus/test";

import parse_with_imports from "./parse_with_imports";

// Borrow semantics in the struct world (STRUCT_PLAN_3 R). The class-era
// "child-group borrow" invalidation is gone with the class tier: a field or
// container read of an OWNING element is a deep COPY (Buffer's
// deep-copy-on-store), so the reader owns its value and owner mutation cannot
// dangle it — invalidation is replaced by copy semantics. What survives:
//   - mv-typed field reads by value are rejected (use `mv ... swap`);
//   - `ref Box<T>` object-level aliases are LENIENT — mutating the owner is
//     visible through the alias and never invalidates it (§A5, status-quo);
//   - container element reads re-fetched after mutation are fine (copies).
// This file pins those shapes.

function errors(input: string): string[] {
	return parse_with_imports(input).errors.map((e) => e.message);
}

describe("mv field reads are copies (rejected without a swap)", () => {
	test("reading a mv field by value is rejected", () => {
		const input = `
mv struct Box { var int value }
mv struct Holder {
	var Box content
	var int scratch
	func poke = (ref self) {
		self.scratch = self.scratch + 1
	}
}
var Holder h = Holder(mv Box(1), 0)
var Box b = h.content
Console.write("\\{b.value}")
`;
		expect(errors(input).some((m) => m.includes("cannot copy 'Box' out of field"))).toBe(true);
	});

	test("a swap transfer revalidates the field", () => {
		const input = `
mv struct Box { var int value }
mv struct Holder {
	var Box content
	var int scratch
	func poke = (ref self) {
		self.scratch = self.scratch + 1
	}
}
var Holder h = Holder(mv Box(1), 0)
var Box b = mv h.content swap Box(0)
h.poke()
Console.write("\\{b.value}")
`;
		expect(errors(input)).toEqual([]);
	});
});

describe("container element reads are copies (owner mutation is irrelevant)", () => {
	test("re-fetching an element after a push is allowed", () => {
		const input = `
mv struct Animal { var char letter }
var List<Animal> list = List<Animal>()
list.push(mv Animal('A'))
if list.length > 0 {
	var Animal a = list.at_or_panic(0)
	list.push(mv Animal('B'))
	a = list.at_or_panic(0)
	Console.write("\\{a.letter}")
}
`;
		expect(errors(input)).toEqual([]);
	});

	test("an element copy survives a sibling push", () => {
		const input = `
mv struct Cell { var int value }
var List<Cell> items = List<Cell>()
items.push(mv Cell(1))
var Cell b = items.at_or_panic(0)
items.push(mv Cell(2))
Console.write("\\{b.value}")
`;
		expect(errors(input)).toEqual([]);
	});
});

describe("object-level aliases are lenient (never invalidated by owner mutation)", () => {
	test("a Box alias sees mutations through the owner", () => {
		const input = `
mv struct Counter {
	var int count = 0
	func bump = (ref self) {
		self.count = self.count + 1
	}
}
var Box<Counter> p = Box<Counter>(Counter())
ref Box<Counter> q = p
p.bump()
Console.write("\\{q.count}")
`;
		expect(errors(input)).toEqual([]);
	});

	test("two aliases: mutating one owner leaves the other alone", () => {
		const input = `
mv struct Cell {
	var int value = 0
	func bump = (ref self) {
		self.value = self.value + 1
	}
}
var Box<Cell> x = Box<Cell>(Cell())
var Box<Cell> y = Box<Cell>(Cell())
x.bump()
Console.write("\\{y.value}")
`;
		expect(errors(input)).toEqual([]);
	});

	test("an alias survives a mutation inside an if-body", () => {
		const input = `
mv struct Counter {
	var int count = 0
	func bump = (ref self) {
		self.count = self.count + 1
	}
}
var Box<Counter> p = Box<Counter>(Counter())
ref Box<Counter> q = p
if true {
	p.bump()
}
Console.write("\\{q.count}")
`;
		expect(errors(input)).toEqual([]);
	});

	test("an alias survives a mutation inside a switch case", () => {
		const input = `
mv struct Counter {
	var int count = 0
	func bump = (ref self) {
		self.count = self.count + 1
	}
}
var Box<Counter> p = Box<Counter>(Counter())
ref Box<Counter> q = p
var int x = 1
switch {
	case x > 0 {
		p.bump()
	}
}
Console.write("\\{q.count}")
`;
		expect(errors(input)).toEqual([]);
	});

	test("an alias survives a mutation inside a match case", () => {
		const input = `
mv struct Counter {
	var int count = 0
	func bump = (ref self) {
		self.count = self.count + 1
	}
}
var Box<Counter> p = Box<Counter>(Counter())
ref Box<Counter> q = p
var int x = 1
match x {
	case 1 {
		p.bump()
	}
	else {
		Console.write("else")
	}
}
Console.write("\\{q.count}")
`;
		expect(errors(input)).toEqual([]);
	});
});
