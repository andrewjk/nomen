import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Exact-length facts for List<T> (`known_length` flow tracking) and the
// contract-discharge extensions built on them. The verifier now models the
// List mutators' length effects — push appends one element, pop /
// remove_at_or_panic remove one (floor 0), set/set_or_panic/reserve are
// neutral, and any other `ref self` mutator kills the exact fact — so an
// unguarded `xs.at(i)` verifies when the pushes/pops prove the index in
// bounds. Locals only (a global's length can change behind the caller's
// back through any opaque callee).
//
// Alongside the effect model, the discharge rules gained: an INCLUSIVE
// lower bound implies a strict one one step up (`>= 2` ⟹ `> 1`), a
// singleton-range variable counts as a constant (`var int idx = 1`), a
// negated guard records the inverted comparison (`if !(x.length <= 0)`),
// a length-snapshot alias carries its guard (`var n = x.length; if n > 0`),
// and an exact-length fact discharges the flipped comparison numerically.
// Pop/remove_at narrow derived facts (decrement literal lower bounds,
// drop symbolic ones) so a stale pre-pop fact can't prove an OOB read.

function errors_of(source: string): string[] {
	const parsed = parse_with_imports(source);
	return parsed.errors.map((e) => e.message);
}

describe("List length facts discharge the at() contract", () => {
	// The FOLLOWUP shapes that motivated the work: push/pop effects are
	// length facts.
	test("push then unguarded at(0)", () => {
		expect(
			errors_of(`
			var List<int> x = List<int>()
			x.push(2)
			var int y = x.at(0)
		`),
		).toEqual([]);
	});

	test("push,push,pop then unguarded at(0)", () => {
		expect(
			errors_of(`
			var List<int> x = List<int>()
			x.push(2)
			x.push(4)
			x.pop()
			var int y = x.at(0)
		`),
		).toEqual([]);
	});

	test("push,push then unguarded at(1)", () => {
		expect(
			errors_of(`
			var List<int> x = List<int>()
			x.push(2)
			x.push(4)
			var int y = x.at(1)
		`),
		).toEqual([]);
	});

	test("push,push then unguarded at(idx) with idx pinned to 1", () => {
		expect(
			errors_of(`
			var List<int> x = List<int>()
			x.push(2)
			x.push(4)
			var int idx = 1
			var int y = x.at(idx)
		`),
		).toEqual([]);
	});

	// mv-enum elements (the shape the FOLLOWUP entry was recorded for).
	test("mv-enum at(0) after push", () => {
		expect(
			errors_of(`
			mv enum Item {
				case missing
				case small(int id)
			}
			var List<Item> l = List<Item>()
			l.push(Item.small(3))
			var it = l.at(0)
		`),
		).toEqual([]);
	});

	// Scalar element borrows reach List parity with Map (the element-borrow
	// rewrite site verifies the same contract).
	test("ref int borrow from List.at after push", () => {
		expect(
			errors_of(`
			var List<int> x = List<int>()
			x.push(7)
			ref int v = x.at(0)
		`),
		).toEqual([]);
	});

	// Inclusive lower bound implies the strict relation one step up.
	test("if length >= 2 guards at(1)", () => {
		expect(
			errors_of(`
			var List<int> x = List<int>()
			x.push(2)
			x.push(4)
			if x.length >= 2 {
				var int y = x.at(1)
			}
		`),
		).toEqual([]);
	});

	// Negated comparison guard records the inverted relation.
	test("if !(x.length <= 0) guards at(0)", () => {
		expect(
			errors_of(`
			var List<int> x = List<int>()
			x.push(2)
			if !(x.length <= 0) {
				var int y = x.at(0)
			}
		`),
		).toEqual([]);
	});

	// A length-snapshot variable carries its guard through the alias.
	test("var n = x.length; if n > 0 guards at(0)", () => {
		expect(
			errors_of(`
			var List<int> x = List<int>()
			x.push(2)
			var int n = x.length
			if n > 0 {
				var int y = x.at(0)
			}
		`),
		).toEqual([]);
	});

	// Guard-derived facts survive a push (growth cannot invalidate a lower
	// bound) and pop NARROWS them (a literal bound decrements).
	test("guard>1, pop, at(0) still verifies", () => {
		expect(
			errors_of(`
			var List<int> x = List<int>()
			x.push(2)
			x.push(4)
			if x.length > 1 {
				x.pop()
				var int y = x.at(0)
			}
		`),
		).toEqual([]);
	});
});

describe("length facts keep rejecting out-of-bounds shapes", () => {
	test("at(0) on an empty list is provably unsatisfied", () => {
		const errs = errors_of(`
			var List<int> x = List<int>()
			var int y = x.at(0)
		`);
		expect(errs.join(" ")).toContain("not satisfied");
	});

	test("pop to empty then at(0) is provably unsatisfied", () => {
		const errs = errors_of(`
			var List<int> x = List<int>()
			x.push(2)
			x.pop()
			var int y = x.at(0)
		`);
		expect(errs.join(" ")).toContain("not satisfied");
	});

	// The stale-fact hole this work closes: before the pop narrowing, the
	// guard's `length > 1` fact survived the pop and admitted an OOB read at
	// runtime (the real length is 1).
	test("guard>1, pop, at(1) is rejected", () => {
		const errs = errors_of(`
			var List<int> x = List<int>()
			x.push(2)
			x.push(4)
			if x.length > 1 {
				x.pop()
				var int y = x.at(1)
			}
		`);
		expect(errs.join(" ")).toContain("not satisfied");
	});

	// An opaque callee holding the list can mutate it: the exact fact dies.
	test("passing the list to a function kills the exact fact", () => {
		const errs = errors_of(`
			func consume = (List<int> xs, out int) {
				return xs.pop()
			}
			var List<int> x = List<int>()
			x.push(2)
			var int dropped = consume(x)
			var int y = x.at(0)
		`);
		expect(errs.join(" ")).toContain("cannot be verified");
	});

	test("weak guard does not admit a bigger literal index", () => {
		const errs = errors_of(`
			var List<int> x = List<int>()
			x.push(2)
			x.push(4)
			if x.length > 1 {
				var int y = x.at(5)
			}
		`);
		expect(errs.length).toBeGreaterThan(0);
	});
});

// Runtime behavior on both backends under the audit runtime: the reads land
// on real elements and the mv-enum match sums correctly.
describe("length-fact shapes run correctly", () => {
	test("unguarded at after push/pop", async () => {
		await build_and_check_output(
			`
import System

pub func main = (Init init) {
	var List<int> x = List<int>()
	x.push(2)
	x.push(4)
	x.pop()
	Console.write("\\{x.at(0)}")
	x.push(9)
	Console.write(" \\{x.at(1)}")
}
`,
			"len_facts_runtime",
			"2 9",
			true,
		);
	});

	test("mv-enum pop/match drain loop", async () => {
		await build_and_check_output(
			`
import System

mv enum Item {
	case missing
	case small(int id)
	case big(int id, int a, int b)
}

pub func main = (Init init) {
	var List<Item> l = List<Item>()
	l.push(Item.small(1))
	l.push(Item.big(2, 3, 4))
	var int total = 0
	while l.length > 0 {
		match l.pop() {
			case .missing { total += 0 }
			case .small(v) { total += v }
			case .big(id, a, b) { total += id + a + b }
		}
	}
	Console.write("\\{total} \\{l.length}")
}
`,
			"len_facts_mv_enum",
			"10 0",
			true,
		);
	});

	test("scalar element borrow reads the pushed element", async () => {
		await build_and_check_output(
			`
import System

pub func main = (Init init) {
	var List<int> x = List<int>()
	x.push(7)
	ref int v = x.at(0)
	Console.write("\\{v}")
}
`,
			"len_facts_borrow",
			"7",
			true,
		);
	});
});
