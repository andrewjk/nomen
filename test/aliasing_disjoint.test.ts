import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_program } from "./parse_with_imports";

// Aliasing relaxation for disjoint declared sets (the precision piece of
// GROUP_BORROWING.md shortfall 5): two pure `ref` borrows of one object may
// arrive as two parameters of one call when both declare field sets and the
// sets share no field — displacing `items` cannot dangle anything borrowed
// through `other`, so the use-after-free shape the rejection exists for is
// unspellable. Everything else keeps the rejection: a wildcard set may
// displace anything; an ownership parameter (`var`/`mv`) frees the shared
// object, which no field precision makes safe; a const parameter reads the
// whole object, so any mutation can tear it; intersecting sets are the
// original hazard.

describe("aliasing relaxation for disjoint declared sets", () => {
	const mk = (poke: string, call: string) =>
		parse_program(`
import System

mv struct Store {
	var List<int> items = List<int>()
	var int other = 0
}

${poke}

pub func main = () {
	var s = Store()
	${call}
}
`);

	test("disjoint sets on two ref params are accepted", () => {
		const parsed = mk(
			`func poke = (ref Store a { items }, ref Store b { other }) {
	a.items.push(42)
	b.other = 7
}`,
			"poke(ref s, ref s)",
		);
		expect(parsed.errors).toEqual([]);
	});

	test("disjoint sets on self and a ref param are accepted", () => {
		const parsed = parse_program(`
import System

mv struct Holder {
	var List<int> items = List<int>()
	var int other = 0

	func poke = (ref self { items }, ref Holder b { other }) {
		self.items.push(b.other)
	}
}

pub func main = () {
	var h = Holder()
	h.poke(ref h)
}
`);
		expect(parsed.errors).toEqual([]);
	});

	test("intersecting sets are still rejected", () => {
		const parsed = mk(
			`func poke = (ref Store a { items }, ref Store b { items }) {
	a.items.push(42)
}`,
			"poke(ref s, ref s)",
		);
		expect(parsed.errors.some((e) => e.message.includes("Aliasing"))).toBe(true);
	});

	test("a wildcard (un-annotated) param still rejects the alias", () => {
		const parsed = mk(
			`func poke = (ref Store a { items }, ref Store b) {
	a.items.push(42)
}`,
			"poke(ref s, ref s)",
		);
		expect(parsed.errors.some((e) => e.message.includes("Aliasing"))).toBe(true);
	});

	test("empty sets are disjoint with everything", () => {
		const parsed = mk(
			`func poke = (ref Store a {}, ref Store b {}) {
	Console.write("touched")
}`,
			"poke(ref s, ref s)",
		);
		expect(parsed.errors).toEqual([]);
	});

	test("an ownership (var) param aliasing a ref param is still rejected", () => {
		const parsed = mk(
			`func poke = (var Store a, ref Store b { other }) {
	Console.write("touched")
}`,
			"poke(s, ref s)",
		);
		expect(parsed.errors.some((e) => e.message.includes("Aliasing"))).toBe(true);
	});

	test("a const param aliasing a mutable param is still rejected", () => {
		const parsed = mk(
			`func poke = (Store a, ref Store b { other }) {
	Console.write("\\{a.other}")
}`,
			"poke(s, ref s)",
		);
		expect(parsed.errors.some((e) => e.message.includes("Aliasing"))).toBe(true);
	});

	test("a third alias is judged against every previous param", () => {
		// a {items} and b {other} are pairwise disjoint; c {items} intersects
		// a — the rejection names a, not b.
		const parsed = mk(
			`func poke = (ref Store a { items }, ref Store b { other }, ref Store c { items }) {
	a.items.push(42)
}`,
			"poke(ref s, ref s, ref s)",
		);
		expect(parsed.errors.some((e) => e.message.includes("'a'"))).toBe(true);
	});

	test("forwarding aliased params to wildcard params is rejected in the callee", () => {
		// The relaxation composes soundly: the outer call is legal (disjoint
		// sets), but the callee forwards its annotated aliases to wildcard
		// parameters — the declared-effects ref-arg check rejects the
		// forward, because a wildcard callee may displace anything through
		// either alias.
		const parsed = parse_program(`
import System

mv struct Store {
	var List<int> items = List<int>()
	var int other = 0
}

func inner = (ref Store a, ref Store b) {
	Console.write("touched")
}

func outer = (ref Store a { items }, ref Store b { other }) {
	inner(ref a, ref b)
}

pub func main = () {
	var s = Store()
	outer(ref s, ref s)
}
`);
		expect(
			parsed.errors.some((e) => e.message.includes("escapes this function's declared fields")),
		).toBe(true);
	});

	test("runtime: disjoint aliasing mutates each side, both backends", async () => {
		await build_and_check_output(
			`
mv struct Store {
	var List<int> items = List<int>()
	var int other = 0
}

func poke = (ref Store a { items }, ref Store b { other }) {
	a.items.push(42)
	b.other = 7
}

var s = Store()
poke(ref s, ref s)
Console.write("\\{s.items.length} \\{s.other}")
`,
			"alias_disjoint",
			"1 7",
		);
	});
});
