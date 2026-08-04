import { describe, expect, test } from "vite-plus/test";

import {
	all_members,
	analyze,
	def_at,
	find_member,
	lookup_at,
	ref_at,
	refs_to,
	resolve_chain,
	symbol_at,
} from "../extension/src/analysis";
import type { Analysis } from "../extension/src/analysis";
import parse from "../src/parse";

// The editor extension indexes the parsed tree to answer hover, go to
// definition, find references and member completion. These tests exercise that
// index directly (no vscode APIs involved).

function index(source: string): { analysis: Analysis; source: string } {
	const parsed = parse(source);
	return { analysis: analyze(parsed.root, source), source };
}

// The offset of the nth (1-based) occurrence of `text` in `source`.
function at(source: string, text: string, nth = 1): number {
	let found = -1;
	for (let i = 0; i < nth; i++) {
		found = source.indexOf(text, found + 1);
		expect(found).toBeGreaterThanOrEqual(0);
	}
	return found;
}

describe("extension analysis", () => {
	test("indexes a variable declaration", () => {
		const source = `
func main = () {
	const int blah = 5
	Console.write("\\{blah}")
}
`;
		const { analysis } = index(source);
		const def = def_at(analysis, at(source, "blah"));
		expect(def?.kind).toEqual("variable");
		expect(def?.signature).toEqual("const int blah");
		expect(def?.type?.name).toEqual("int");
	});

	test("indexes a declaration with an inferred type", () => {
		const source = `
func main = () {
	var count = 5
	Console.write("\\{count}")
}
`;
		const { analysis } = index(source);
		const def = def_at(analysis, at(source, "count"));
		expect(def?.kind).toEqual("variable");
		expect(def?.type?.name).toEqual("int");
	});

	test("resolves a variable reference to its declaration", () => {
		const source = `
func main = () {
	const int blah = 5
	Console.write("\\{blah}")
}
`;
		const { analysis } = index(source);
		const use = ref_at(analysis, at(source, "blah", 2));
		expect(use?.def.start).toEqual(at(source, "blah"));
		expect(use?.length).toEqual(4);
	});

	test("keeps shadowed variables in separate scopes", () => {
		const source = `
func one = () {
	const int shared = 1
	Console.write("\\{shared}")
}
func two = () {
	const int shared = 2
	Console.write("\\{shared}")
}
`;
		const { analysis } = index(source);
		const first = def_at(analysis, at(source, "shared"));
		const second = def_at(analysis, at(source, "shared", 3));
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(refs_to(analysis, first!).map((r) => r.start)).toEqual([at(source, "shared", 2)]);
		expect(refs_to(analysis, second!).map((r) => r.start)).toEqual([at(source, "shared", 4)]);
	});

	test("indexes struct fields and methods", () => {
		const source = `
struct Point {
	var int x = 0
	pub func shift = (ref self, int by) {
		self.x = self.x + by
	}
}
`;
		const { analysis } = index(source);
		const point = analysis.types.get("Point")!;
		expect(point.fields.get("x")?.signature).toEqual("pub var int x");
		expect(point.fields.get("x")?.container).toEqual("Point");
		expect(point.methods.get("shift")?.signature).toEqual("pub func shift = (ref self, int by)");
	});

	test("resolves trait conformance refs on a struct", () => {
		const source = `
trait Drawable {}
struct Button : Drawable {}
`;
		const { analysis } = index(source);
		// The `Drawable` in `: Drawable` is the 2nd occurrence.
		const use = ref_at(analysis, at(source, "Drawable", 2));
		expect(use?.def.kind).toEqual("trait");
		expect(use?.def.start).toEqual(at(source, "Drawable"));
	});

	test("resolves trait conformance refs on an extend", () => {
		const source = `
trait Countable {}
struct List {}
extend struct List : Countable {}
`;
		const { analysis } = index(source);
		// The `Countable` in `: Countable` is the 2nd occurrence.
		const use = ref_at(analysis, at(source, "Countable", 2));
		expect(use?.def.kind).toEqual("trait");
		expect(use?.def.start).toEqual(at(source, "Countable"));
	});

	test("resolves a field access through the receiver's type", () => {
		const source = `
struct Point {
	var int x = 0
}
func main = () {
	var Point p = Point()
	Console.write("\\{p.x}")
}
`;
		const { analysis } = index(source);
		const use = ref_at(analysis, at(source, "x", 2));
		expect(use?.def.kind).toEqual("field");
		expect(use?.def.start).toEqual(at(source, "x"));
	});

	test("resolves a method call on a field", () => {
		const source = `
struct Inner {
	pub func hello = (self, out int) {
		return 1
	}
}
struct Outer {
	var Inner inner = Inner()
	pub func call = (self, out int) {
		return self.inner.hello()
	}
}
`;
		const { analysis } = index(source);
		const use = ref_at(analysis, at(source, "hello", 2));
		expect(use?.def.kind).toEqual("method");
		expect(use?.def.container).toEqual("Inner");
	});

	test("resolves a call to a function and a constructor", () => {
		const source = `
struct Point {
	var int x = 0
}
func helper = (out int) {
	return 1
}
func main = () {
	var Point p = Point()
	Console.write("\\{helper()}")
}
`;
		const { analysis } = index(source);
		expect(ref_at(analysis, at(source, "Point()"))?.def.kind).toEqual("struct");
		expect(ref_at(analysis, at(source, "helper()"))?.def.kind).toEqual("func");
	});

	test("finds every reference to a field", () => {
		const source = `
struct Point {
	var int x = 0
	pub func double = (ref self) {
		self.x = self.x * 2
	}
}
func main = () {
	var Point p = Point()
	p.x = 3
}
`;
		const { analysis } = index(source);
		const def = symbol_at(analysis, at(source, "x"))!;
		expect(def.kind).toEqual("field");
		expect(refs_to(analysis, def).length).toEqual(3);
	});

	test("indexes parameters and self", () => {
		const source = `
struct Point {
	var int x = 0
	pub func shift = (ref self, int by) {
		self.x = self.x + by
	}
}
`;
		const { analysis } = index(source);
		const by = def_at(analysis, at(source, "by"));
		expect(by?.kind).toEqual("param");
		expect(by?.signature).toEqual("int by");
		const self_use = ref_at(analysis, at(source, "self", 2));
		expect(self_use?.def.type?.name).toEqual("Point");
	});

	test("indexes enum cases", () => {
		const source = `
enum Direction {
	case north
	case south
}
func main = () {
	var Direction d = Direction.north
}
`;
		const { analysis } = index(source);
		const direction = analysis.types.get("Direction")!;
		expect([...direction.cases.keys()]).toEqual(["north", "south"]);
		expect(ref_at(analysis, at(source, "north", 2))?.def.kind).toEqual("case");
	});

	test("completes the members of a struct instance", () => {
		const source = `
struct Point {
	var int x = 0
	pub func shift = (ref self, int by) {
		self.x = self.x + by
	}
	func secret = (self) {
	}
}
func main = () {
	var Point p = Point()
}
`;
		const { analysis } = index(source);
		const offset = source.length;
		const resolved = resolve_chain(analysis, ["p"], offset)!;
		expect(resolved.is_static).toEqual(false);
		const names = all_members(analysis.types, resolved.info).map((m) => m.name);
		expect(names).toContain("x");
		expect(names).toContain("shift");
	});

	test("completes the members of a field's type", () => {
		const source = `
struct Inner {
	var int value = 0
}
struct Outer {
	var Inner inner = Inner()
	pub func use = (self) {
		var int v = self.inner.value
	}
}
`;
		const { analysis } = index(source);
		const offset = at(source, "self.inner.value");
		const resolved = resolve_chain(analysis, ["self", "inner"], offset)!;
		expect(resolved.info.name).toEqual("Inner");
		expect(find_member(analysis.types, resolved.info, "value")).toBeDefined();
	});

	test("completes a type's static members", () => {
		const source = `
struct Point {
	var int x = 0
	pub func origin = (out int) {
		return 0
	}
}
`;
		const { analysis } = index(source);
		const resolved = resolve_chain(analysis, ["Point"], source.length)!;
		expect(resolved.is_static).toEqual(true);
		expect(resolved.info.methods.get("origin")?.is_static).toEqual(true);
	});

	test("looks a local up from a position", () => {
		const source = `
func main = () {
	var int total = 0
	total = total + 1
}
`;
		const { analysis } = index(source);
		const found = lookup_at(analysis, "total", at(source, "total", 2));
		expect(found?.start).toEqual(at(source, "total"));
	});

	test("keeps documentation comments on declarations", () => {
		const source = `
/**
 * A point in space
 **/
struct Point {
	/**
	 * The horizontal offset
	 **/
	var int x = 0
}
`;
		const { analysis } = index(source);
		expect(def_at(analysis, at(source, "Point"))?.doc).toEqual("A point in space");
		expect(analysis.types.get("Point")?.fields.get("x")?.doc).toEqual("The horizontal offset");
	});
});
