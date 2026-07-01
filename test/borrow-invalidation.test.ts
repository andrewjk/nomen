import { describe, expect, test } from "vite-plus/test";

import parse_with_imports from "./parse_with_imports";

// Child-group borrow invalidation: a borrowed class reference taken from a
// container element or a class field (a "child-group borrow") is invalidated
// when its owner is mutated via a `ref self` / `var self` method call — because
// the mutation may free or displace the contents the borrow points into.
// Object-level aliases (`var q = p`) are NOT child-group borrows, so mutating a
// sibling does not invalidate them. This is the mutable-aliasing benefit over
// Rust's aliasing-xor-mutability, made sound by invalidating on mutation.

describe("child-group borrow invalidation on owner mutation", () => {
	test("container element borrow invalidated by a later mutating call", () => {
		const input = `
class Animal { var char letter }
var List<Animal> list = List<Animal>()
list.push(mov Animal('A'))
var Animal a = list.pop()
list.push(mov Animal('B'))
Console.write("\\{a.letter}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("invalidated"))).toBe(true);
	});

	test("re-fetching the borrow after mutation is allowed", () => {
		const input = `
class Animal { var char letter }
var List<Animal> list = List<Animal>()
list.push(mov Animal('A'))
var Animal a = list.pop()
list.push(mov Animal('B'))
a = list.pop()
Console.write("\\{a.letter}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("object-level alias is not invalidated by mutating a sibling", () => {
		const input = `
class Counter {
	var int count
	func bump = (ref self) {
		self.count = self.count + 1
	}
}
var Counter p = Counter(1)
var Counter q = p
p.bump()
Console.write("\\{q.count}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("two sibling borrows survive mutating one of them", () => {
		const input = `
class Box {
	var int value
	func bump = (ref self) {
		self.value = self.value + 1
	}
}
class Pair {
	mov Box a
	mov Box b
}
var Pair p = Pair(mov Box(1), mov Box(2))
var Box x = p.a
var Box y = p.b
x.bump()
Console.write("\\{y.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("field-path container borrow is invalidated (path receiver)", () => {
		const input = `
class Animal { var char letter }
class Zoo {
	var List<Animal> animals = List<Animal>()
}
var Zoo z = Zoo()
z.animals.push(mov Animal('A'))
var Animal a = z.animals.pop()
z.animals.push(mov Animal('B'))
Console.write("\\{a.letter}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("invalidated"))).toBe(true);
	});

	test("invalidation inside an if-body persists after the block", () => {
		const input = `
class Animal { var char letter }
var List<Animal> list = List<Animal>()
list.push(mov Animal('A'))
var Animal a = list.pop()
if true {
	list.push(mov Animal('B'))
}
Console.write("\\{a.letter}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("invalidated"))).toBe(true);
	});

	test("invalidation inside a switch case persists after the switch", () => {
		const input = `
class Animal { var char letter }
var List<Animal> list = List<Animal>()
list.push(mov Animal('A'))
var Animal a = list.pop()
var int x = 1
switch {
	case x > 0 {
		list.push(mov Animal('B'))
	}
}
Console.write("\\{a.letter}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("invalidated"))).toBe(true);
	});

	test("invalidation inside a match case persists after the match", () => {
		const input = `
class Animal { var char letter }
var List<Animal> list = List<Animal>()
list.push(mov Animal('A'))
var Animal a = list.pop()
var int x = 1
match x {
	case 1 {
		list.push(mov Animal('B'))
	}
	else {
		Console.write("else")
	}
}
Console.write("\\{a.letter}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("invalidated"))).toBe(true);
	});
});
