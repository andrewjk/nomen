import { describe, expect, test } from "vite-plus/test";

import parse_program from "./parse_with_imports";

/**
 * Declared field sets (docs/FIELD_EFFECTS.md): a `ref` parameter may declare
 * the fields it may displace — `ref Item item { name }`, `{}` for none. The
 * declaration is verified locally (three rules) and drives field-scoped
 * borrow invalidation at call sites; un-annotated parameters stay wildcards.
 */

function run(source: string): { errors: string[]; warnings: string[] } {
	// NOTE: these programs deliberately avoid structs with direct string
	// fields — a pre-existing first-check-only synthesized-#init error (no
	// source offset, see FOLLOWUP.md) makes parse report ok:false with no
	// visible errors, which suppresses the warning pass.
	const parsed = parse_program(source);
	return {
		errors: parsed.errors.map((e) => e.message),
		warnings: parsed.warnings.map((e) => e.message),
	};
}

const INVALIDATED = (borrow: string, owner: string) =>
	`Borrow '${borrow}' was invalidated by a mutation of its owner of '${owner}'; re-fetch it after the mutation`;

describe("parse: field sets", () => {
	test("brace sets parse on ref params and ref self", () => {
		const r = run(`
mv struct Box2 {
	var int a = 0
	var int b = 0
	var int c = 0

	func s = (ref self { a }) {
		self.a = self.a + 1
	}
}

func f = (ref Box2 x { a, b }) {
	x.a = x.a + 1
	x.b = x.b + 1
}
func g = (ref Box2 x {}) {
	x.a = x.a + 1
}

pub func main = (Init init) {
	var Box2 v = Box2()
	f(ref v)
	g(ref v)
	v.s()
}
`);
		expect(r.errors).toEqual([]);
	});

	test("duplicate fields in the set are rejected", () => {
		const r = run(`
mv struct Box2 {
	var int a = 0
}

func f = (ref Box2 x { a, a }) {
	x.a = x.a + 1
}

pub func main = (Init init) {
	var Box2 v = Box2()
	f(ref v)
}
`);
		expect(r.errors.some((m) => m.includes("Duplicate field 'a' in the field set"))).toBe(true);
	});

	test("a field set on a non-ref parameter is rejected", () => {
		const r = run(`
mv struct Box2 {
	var int a = 0
}

func f = (Box2 x { a }) {
	x.a = x.a + 1
}

pub func main = (Init init) {
	var Box2 v = Box2()
	f(v)
}
`);
		expect(
			r.errors.some((m) => m.includes("a field set is only allowed on a 'ref' parameter")),
		).toBe(true);
	});

	test("a field set on a bare self is rejected", () => {
		const r = run(`
mv struct Box2 {
	var int a = 0

	func read = (self { a }, out int) {
		return self.a
	}
}

pub func main = (Init init) {
	var Box2 v = Box2()
	Console.write("\\{v.read()}")
}
`);
		expect(r.errors.some((m) => m.includes("bare 'self' is a read-only receiver"))).toBe(true);
	});

	test("a field set requires a struct-typed ref parameter", () => {
		const r = run(`
func f = (ref int x {}) {
	x = x + 1
}

pub func main = (Init init) {
	var int n = 1
	f(ref n)
}
`);
		expect(
			r.errors.some((m) => m.includes("a field set requires a struct-typed ref parameter")),
		).toBe(true);
	});

	test("unknown field names are rejected", () => {
		const r = run(`
mv struct Box2 {
	var int a = 0
}

func f = (ref Box2 x { nope }) {
	x.a = x.a + 1
}

pub func main = (Init init) {
	var Box2 v = Box2()
	f(ref v)
}
`);
		expect(r.errors.some((m) => m.includes("'Box2' has no field 'nope'"))).toBe(true);
	});
});

describe("self receivers", () => {
	const PROGRAM = `
mv struct Data {
	var int value
}

mv struct Holder {
	var int scratch
	var Box<Data> data

	func poke = (ref self {}) {
		self.scratch = self.scratch + 1
	}

	func replace = (ref self { data }) {
		self.data = mv Box<Data>(mv Data(0))
	}
}

pub func main = (Init init) {
	var Holder h = Holder(0, mv Box<Data>(Data(1)))
	var Box<Data> b = h.data
	h.poke()
	Console.write("\\{b.value}")
}
`;

	test("the empty set keeps a sibling-field borrow alive", () => {
		const r = run(PROGRAM);
		expect(r.errors).toEqual([]);
	});

	test("un-annotated ref self stays a wildcard (whole-owner invalidation)", () => {
		const r = run(PROGRAM.replace(" {}", "").replace(" { data }", ""));
		expect(r.errors).toEqual([INVALIDATED("b", "h")]);
	});

	test("a declared field invalidates exactly the borrows through it", () => {
		const r = run(PROGRAM.replace("h.poke()", "h.replace()"));
		expect(r.errors).toEqual([INVALIDATED("b", "h")]);
	});

	test("value-type writes never need declaring", () => {
		const r = run(`
mv struct Counter {
	var int n
	var Box<Data> data

	func bump = (ref self {}) {
		self.n = self.n + 1
	}
}

mv struct Data {
	var int value
}

pub func main = (Init init) {
	var Counter c = Counter(0, mv Box<Data>(mv Data(1)))
	c.bump()
	Console.write("\\{c.n}")
}
`);
		expect(r.errors).toEqual([]);
	});

	test("rule 1: writing an undeclared heap field is an error", () => {
		const r = run(
			PROGRAM.replace("self.scratch = self.scratch + 1", "self.data = mv Box<Data>(mv Data(9))"),
		);
		expect(
			r.errors.some((m) =>
				m.includes("'poke' declares an empty field set, but the body writes self.data"),
			),
		).toBe(true);
	});

	test("rule 3: calling a wider mutator on self is an error", () => {
		const r = run(
			PROGRAM.replace(
				`	func replace = (ref self { data }) {
		self.data = mv Box<Data>(mv Data(0))
	}`,
				`	func replace = (ref self { data, scratch }) {
		self.data = mv Box<Data>(mv Data(0))
		self.scratch = 0
	}

	func indirect = (ref self {}) {
		self.replace()
	}`,
			),
		);
		expect(
			r.errors.some(
				(m) => m.includes("'replace' may change") && m.includes("'indirect' does not declare"),
			),
		).toBe(true);
	});

	test("idle receiver lint: ref self {} never mutated", () => {
		const r = run(`
mv struct Counter {
	var int n
}

mv struct Holder {
	var Counter c

	func peek = (ref self {}, out int) {
		return self.c.n
	}
}

pub func main = (Init init) {
	var Holder h = Holder(Counter(1))
	Console.write("\\{h.peek()}")
}
`);
		expect(r.errors).toEqual([]);
		expect(r.warnings).toContain(
			"Method receiver 'self' is never mutated — use bare 'self' instead of 'ref self'",
		);
	});

	test("un-annotated ref self reader suggests bare self", () => {
		const r = run(`
mv struct Holder {
	var int n

	func peek = (ref self, out int) {
		return self.n
	}
}

pub func main = (Init init) {
	var Holder h = Holder(1)
	Console.write("\\{h.peek()}")
}
`);
		expect(r.errors).toEqual([]);
		expect(r.warnings).toContain(
			"Method receiver 'self' is never mutated — use bare 'self' instead of 'ref self'",
		);
	});

	test("un-annotated ref self scalar mutator suggests {}", () => {
		const r = run(`
mv struct Counter {
	var int n

	func bump = (ref self) {
		self.n = self.n + 1
	}
}

pub func main = (Init init) {
	var Counter c = Counter(0)
	c.bump()
	Console.write("\\{c.n}")
}
`);
		expect(r.errors).toEqual([]);
		expect(r.warnings).toContain(
			"Method receiver 'self' mutates only value-type storage — declare '{}' so calls keep callers' borrows alive",
		);
	});
});

describe("free ref parameters", () => {
	const PROGRAM = `
mv struct Inner {
	var int n = 0
}

mv struct Item {
	var Box<Inner> inner
	var Box<Inner> spare
}

func touch = (ref Item item { inner }) {
	item.inner = mv Box<Inner>(mv Inner())
}

pub func main = (Init init) {
	var Item item = Item(mv Box<Inner>(mv Inner()), mv Box<Inner>(mv Inner()))
	var Box<Inner> b = item.spare
	touch(ref item)
	item.spare = mv Box<Inner>(mv Inner())
	Console.write("\\{b.n}")
}
`;

	test("a declared set keeps sibling-field borrows alive", () => {
		const r = run(PROGRAM);
		expect(r.errors).toEqual([]);
	});

	test("an un-annotated parameter still invalidates whole-owner", () => {
		const r = run(PROGRAM.replace(" { inner }", ""));
		expect(r.errors).toEqual([INVALIDATED("b", "item")]);
	});

	test("rule 1: an undeclared heap-field write is an error", () => {
		const r = run(PROGRAM.replace("{ inner }", "{}"));
		expect(r.errors).toEqual([
			"'touch' declares an empty field set, but the body writes item.inner",
		]);
	});

	test("rule 1 quick fix payload is attached to the error", () => {
		const parsed = parse_program(PROGRAM.replace("{ inner }", "{}"));
		const fix = parsed.errors.find((e) =>
			e.message.includes("declares an empty field set"),
		)?.quick_fix;
		expect(fix?.title).toContain("'inner'");
	});

	test("rule 1: a whole-value reassignment through a set-bound parameter is an error", () => {
		const r = run(`
mv struct Inner {
	var int n = 0
}

mv struct Item {
	var Box<Inner> inner
}

func reset = (ref Item item {}) {
	item = mv Item(mv Box<Inner>(mv Inner()))
}

pub func main = (Init init) {
	var Item item = Item(mv Box<Inner>(mv Inner()))
	reset(ref item)
}
`);
		expect(r.errors.some((m) => m.includes("the body reassigns 'item'"))).toBe(true);
	});

	test("rule 2: a mutator on an undeclared field is an error", () => {
		const r = run(`
mv struct Inner {
	var int n = 0

	func bump = (ref self) {
		self.n = self.n + 1
	}
}

mv struct Item {
	var Box<Inner> inner
	var Box<Inner> other
}

func touch = (ref Item item {}) {
	item.inner.bump()
}

pub func main = (Init init) {
	var Item item = Item(mv Box<Inner>(mv Inner()), mv Box<Inner>(mv Inner()))
	touch(ref item)
}
`);
		expect(r.errors.some((m) => m.includes("the body calls a mutating method on item.inner"))).toBe(
			true,
		);
	});

	test("rule 2: a declared field passes and kills exactly those borrows", () => {
		const r = run(`
mv struct Inner {
	var int n = 0

	func bump = (ref self) {
		self.n = self.n + 1
	}
}

mv struct Item {
	var Box<Inner> inner
	var Box<Inner> other
}

func touch = (ref Item item { inner }) {
	item.inner.bump()
}

pub func main = (Init init) {
	var Item item = Item(mv Box<Inner>(mv Inner()), mv Box<Inner>(mv Inner()))
	var Box<Inner> o = item.other
	touch(ref item)
	item.other = mv Box<Inner>(mv Inner())
	Console.write("\\{o.n}")
}
`);
		expect(r.errors).toEqual([]);
	});

	test("rule 3: forwarding to a wider ref parameter is an error", () => {
		const r = run(
			PROGRAM.replace(
				`func touch = (ref Item item { inner }) {
	item.inner = mv Box<Inner>(mv Inner())
}`,
				`func widen = (ref Item item { inner, spare }) {
	item.spare = mv Box<Inner>(mv Inner())
}

func touch = (ref Item item { inner }) {
	widen(ref item)
}`,
			),
		);
		expect(r.errors.some((m) => m.includes("'spare'") && m.includes("does not declare"))).toBe(
			true,
		);
	});

	test("rule 3: a wildcard callee is an error for a set-bound parameter", () => {
		const r = run(
			PROGRAM.replace(
				`func touch = (ref Item item { inner }) {
	item.inner = mv Box<Inner>(mv Inner())
}`,
				`func consume = (ref Item item) {
	item.inner = mv Box<Inner>(mv Inner())
}

func touch = (ref Item item { inner }) {
	consume(ref item)
}`,
			),
		);
		expect(
			r.errors.some(
				(m) => m.includes("the callee declares no field set") && m.includes("may change any field"),
			),
		).toBe(true);
	});

	test("rule 3: a subset callee passes", () => {
		const r = run(`
mv struct Inner {
	var int n = 0
}

mv struct Item {
	var Box<Inner> inner
	var Box<Inner> spare
}

func narrow = (ref Item item { inner }) {
	item.inner = mv Box<Inner>(mv Inner())
}

func touch = (ref Item item { inner, spare }) {
	item.spare = mv Box<Inner>(mv Inner())
	narrow(ref item)
}

pub func main = (Init init) {
	var Item item = Item(mv Box<Inner>(mv Inner()), mv Box<Inner>(mv Inner()))
	touch(ref item)
}
`);
		expect(r.errors).toEqual([]);
	});

	test("wildcard hint: a body that mutates a heap field without a set warns", () => {
		const r = run(
			PROGRAM.replace(" { inner }", "").replace(
				`	var Box<Inner> b = item.spare
	touch(ref item)
	item.spare = mv Box<Inner>(mv Inner())
	Console.write("\\{b.n}")`,
				`	touch(ref item)
	item.spare = mv Box<Inner>(mv Inner())
	Console.write("\\{item.spare.n}")`,
			),
		);
		expect(r.errors).toEqual([]);
		expect(r.warnings).toContain(
			"Ref parameter 'item' changes 'inner' through the alias without declaring it — add '{ inner }' to narrow invalidation for callers",
		);
	});

	test("idle-ref lint: a ref parameter with {} that is never written through warns", () => {
		const r = run(`
struct Item {
	var int n
}

func read = (ref Item item {}, out int) {
	return item.n
}

pub func main = (Init init) {
	var Item item = Item(7)
	Console.write("\\{read(ref item)}")
}
`);
		expect(r.errors).toEqual([]);
		expect(r.warnings).toContain(
			"Ref parameter 'item' declares the empty field set but is never written through — take it by value (or drop 'ref')",
		);
	});

	test("idle-ref lint skips owning (mv) structs — ref is their borrow spelling", () => {
		const r = run(`
mv struct Inner {
	var int n = 0
}

mv struct Item {
	var Box<Inner> inner
}

func read = (ref Item item {}, out int) {
	return item.inner.n
}

pub func main = (Init init) {
	var Item item = Item(mv Box<Inner>(mv Inner()))
	Console.write("\\{read(ref item)}")
}
`);
		expect(r.errors).toEqual([]);
		expect(r.warnings.some((m) => m.includes("never written through"))).toBe(false);
	});

	test("un-annotated owning reader suggests {}", () => {
		const r = run(`
mv struct Inner {
	var int n = 0
}

mv struct Item {
	var Box<Inner> inner
}

func read = (ref Item item, out int) {
	return item.inner.n
}

pub func main = (Init init) {
	var Item item = Item(mv Box<Inner>(mv Inner()))
	Console.write("\\{read(ref item)}")
}
`);
		expect(r.errors).toEqual([]);
		expect(r.warnings).toContain(
			"Ref parameter 'item' is never written through — declare '{}' so calls keep callers' borrows alive",
		);
	});

	test("un-annotated copyable reader suggests taking it by value", () => {
		const r = run(`
struct Item {
	var int n
}

func read = (ref Item item, out int) {
	return item.n
}

pub func main = (Init init) {
	var Item item = Item(7)
	Console.write("\\{read(ref item)}")
}
`);
		expect(r.errors).toEqual([]);
		expect(r.warnings).toContain(
			"Ref parameter 'item' is never written through — take it by value (or drop 'ref')",
		);
	});

	test("un-annotated scalar mutator suggests {}", () => {
		const r = run(`
mv struct Item {
	var int n
}

func bump = (ref Item item) {
	item.n = item.n + 1
}

pub func main = (Init init) {
	var Item item = Item(0)
	bump(ref item)
}
`);
		expect(r.errors).toEqual([]);
		expect(r.warnings).toContain(
			"Ref parameter 'item' displaces no heap field — declare '{}' so calls keep callers' borrows alive",
		);
	});

	test("forwarding to a wildcard callee keeps the param unknown (no {} advice)", () => {
		const r = run(`
mv struct Item {
	var int n
	var Box<Inner> inner
}

mv struct Inner {
	var int x = 0
}

func reset = (ref Item item) {
	item.inner = mv Box<Inner>(mv Inner())
}

func forward = (ref Item item) {
	reset(ref item)
}

pub func main = (Init init) {
	var Item item = Item(0, mv Box<Inner>(mv Inner()))
	forward(ref item)
}
`);
		expect(r.errors).toEqual([]);
		const forward_warning = r.warnings.find(
			(m) =>
				m.includes("'forward'") || (m.includes("Ref parameter 'item'") && m.includes("any field")),
		);
		expect(forward_warning).toBeDefined();
		expect(r.warnings.some((m) => m.includes("displaces no heap field"))).toBe(false);
	});

	test("forwarding the parameter as a ref argument counts as use", () => {
		const r = run(`
struct Item {
	var int count
	var int total
}

func nudge = (ref Item item {}) {
	item.count = item.count + 1
}

func forward = (ref Item item {}) {
	nudge(ref item)
}

pub func main = (Init init) {
	var Item item = Item(0, 0)
	forward(ref item)
}
`);
		expect(r.errors).toEqual([]);
		expect(r.warnings.some((m) => m.includes("never written through"))).toBe(false);
	});
});

describe("generic structs", () => {
	test("scalar field writes in a generic template need no declaration", () => {
		// Regression: the checker used to fail to resolve a generic template's
		// field types, so `self.started = true` looked heap-displacing and an
		// exact `{}` set was rejected.
		const r = run(`
pub struct Launcher<T> {
	var T job
	var bool started = false

	func mark = (ref self {}) {
		self.started = true
	}
}

pub func main = (Init init) {
}
`);
		expect(r.errors).toEqual([]);
	});

	test("generic template field sets are validated against the template's fields", () => {
		const r = run(`
pub struct Wrapper<T> {
	var T value
	var int hits = 0

	func take = (ref self { value }) {
		self.hits = self.hits + 1
	}

	func typo = (ref self { nope }) {
		self.hits = self.hits + 1
	}
}

pub func main = (Init init) {
}
`);
		expect(r.errors.some((m) => m.includes("'Wrapper' has no field 'nope'"))).toBe(true);
	});
});

describe("traits", () => {
	const TRAIT = `
mv struct Data {
	var int value
}

trait Holder {
	func poke = (ref self {})
	func replace = (ref self { data })
}

mv struct H: Holder {
	var int scratch
	var Box<Data> data

	func poke = (ref self {}) {
		self.scratch = self.scratch + 1
	}

	func replace = (ref self { data }) {
		self.data = mv Box<Data>(mv Data(0))
	}
}
`;

	test("conformer may declare the same (subset) set", () => {
		const r = run(`${TRAIT}

pub func main = (Init init) {
	var H h = H(0, mv Box<Data>(Data(1)))
	h.poke()
	h.replace()
}
`);
		expect(r.errors).toEqual([]);
	});

	test("a conformer without the set is rejected (widens to wildcard)", () => {
		const r = run(
			TRAIT.replace(
				`	func poke = (ref self {}) {
		self.scratch = self.scratch + 1
	}`,
				`	func poke = (ref self) {
		self.scratch = self.scratch + 1
	}`,
			),
		);
		expect(r.errors.some((m) => m.includes("the override must declare a subset"))).toBe(true);
	});

	test("a conformer may not name fields outside the trait's set", () => {
		const r = run(
			TRAIT.replace(
				`	func replace = (ref self { data }) {
		self.data = mv Box<Data>(mv Data(0))
	}`,
				`	func replace = (ref self { data, scratch }) {
		self.data = mv Box<Data>(mv Data(0))
		self.scratch = 0
	}`,
			),
		);
		expect(r.errors.some((m) => m.includes("widens the trait's field set"))).toBe(true);
	});

	test("calls through the trait type invalidate per the trait's set", () => {
		const r = run(`${TRAIT}

pub func main = (Init init) {
	var H h = H(0, mv Box<Data>(Data(1)))
	var Box<Data> b = h.data
	h.poke()
	Console.write("\\{b.value}")
}
`);
		expect(r.errors).toEqual([]);
	});

	test("un-annotated trait methods stay wildcards through the trait call", () => {
		const r = run(`${TRAIT.replace(/ \{\}/g, "").replace(" { data }", "")}

pub func main = (Init init) {
	var H h = H(0, mv Box<Data>(Data(1)))
	var Box<Data> b = h.data
	h.poke()
	Console.write("\\{b.value}")
}
`);
		expect(r.errors).toEqual([INVALIDATED("b", "h")]);
	});
});
