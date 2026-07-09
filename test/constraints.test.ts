import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";

const core = path.resolve(import.meta.dirname, "../core");

describe("constraints", () => {
	describe("parameter constraints", () => {
		test("simple literal index violates constraint", () => {
			const input = `
import System
func restricted = (int i: i > 0) {
    Console.write("ok")
}
func caller = () {
    restricted(0)
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
		});

		test("simple literal index satisfies constraint", () => {
			const input = `
import System
func restricted = (int i: i > 0) {
    Console.write("ok")
}
func caller = () {
    restricted(5)
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("array length constraint violation", () => {
			const input = `
import System
func restricted = (Array<string> source, int i: i < source.length) {
    Console.write("ok")
}
func caller = () {
    restricted(Array("a", "b", "c"), 4)
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
		});

		test("array length constraint satisfied", () => {
			const input = `
import System
func restricted = (Array<string> source, int i: i < source.length) {
    Console.write("ok")
}
func caller = () {
    restricted(Array("a", "b", "c"), 2)
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("compound constraint violated", () => {
			const input = `
import System
func restricted = (Array<string> source, int i: i >= 0 && i < source.length) {
    Console.write("ok")
}
func caller = () {
    restricted(Array("a", "b", "c"), 5)
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
		});

		test("compound constraint satisfied", () => {
			const input = `
import System
func restricted = (Array<string> source, int i: i >= 0 && i < source.length) {
    Console.write("ok")
}
func caller = () {
    restricted(Array("a", "b", "c"), 2)
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("compound constraint with variable array violated", () => {
			const input = `
import System
func restricted = (Array<string> source, int i: i >= 0 && i < source.length) {
    Console.write("ok")
}
func caller = () {
    var things = Array("a", "b", "c")
    restricted(things, 4)
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
		});

		test("for-loop variable satisfies compound constraint", () => {
			const input = `
import System
func restricted = (Array<string> source, int i: i >= 0 && i < source.length) {
    Console.write("ok")
}
func caller = () {
    var things = Array("a", "b", "c")
    for i of 0 .. things.length {
        restricted(things, i)
    }
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("for-loop variable modified before constraint check fails", () => {
			const input = `
import System
func restricted = (Array<string> source, int i: i >= 0 && i < source.length) {
    Console.write("ok")
}
func caller = () {
    var things = Array("a", "b", "c")
    for i of 0 .. things.length {
        i += 1
        restricted(things, i)
    }
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("cannot be verified"))).toBe(true);
		});

		test("for-loop variable with non-literal range fails constraint", () => {
			const input = `
import System
func restricted = (Array<string> source, int i: i >= 0 && i < source.length) {
    Console.write("ok")
}
func caller = () {
    var things = Array("a", "b", "c")
    var start = 0
    for i of start .. things.length {
        restricted(things, i)
    }
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("cannot be verified"))).toBe(true);
		});

		test("for-loop variable satisfies lower bound only", () => {
			const input = `
import System
func check = (int i: i >= 0) {
    Console.write("ok")
}
func caller = () {
    for i of 0 .. 10 {
        check(i)
    }
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("for-loop variable satisfies upper bound only", () => {
			const input = `
import System
func check = (int i: i < 10) {
    Console.write("ok")
}
func caller = () {
    for i of 0 .. 10 {
        check(i)
    }
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("for-loop variable range does not satisfy lower bound", () => {
			const input = `
import System
func check = (int i: i >= 5) {
    Console.write("ok")
}
func caller = () {
    for i of 0 .. 3 {
        check(i)
    }
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
		});

		test("for-loop variable range does not satisfy upper bound", () => {
			const input = `
import System
func check = (int i: i < 3) {
    Console.write("ok")
}
func caller = () {
    for i of 0 .. 5 {
        check(i)
    }
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
		});

		test("for-loop variable satisfies i <= constraint", () => {
			const input = `
import System
func check = (int i: i <= 9) {
    Console.write("ok")
}
func caller = () {
    for i of 0 .. 10 {
        check(i)
    }
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("while loop variable satisfies constraint via flow analysis", () => {
			// The flow analysis tracks `k < things.length` from the while condition
			// and uses it to verify the constraint at the call site.
			const input = `
import System
func restricted = (Array<string> source, int i: i >= 0 && i < source.length) {
    Console.write("ok")
}
func caller = () {
    var things = Array("a", "b", "c")
    var k = 0
    while k < things.length; k += 1 {
        restricted(things, k)
    }
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("constraint comparing int with string errors", () => {
			const input = `
import System
func bad = (int i: i > "abc") {
    Console.write("ok")
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("Type mismatch"))).toBe(true);
		});

		test("constraint that is just an int literal errors", () => {
			const input = `
import System
func bad = (int i: 5) {
    Console.write("ok")
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.some((e) => e.message.includes("boolean expression"))).toBe(true);
		});

		test("constraint that is arithmetic expression errors", () => {
			const input = `
import System
func bad = (int i: i + 1) {
    Console.write("ok")
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.some((e) => e.message.includes("boolean expression"))).toBe(true);
		});

		test("constraint that is a string literal errors", () => {
			const input = `
import System
func bad = (int i: "hello") {
    Console.write("ok")
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.some((e) => e.message.includes("boolean expression"))).toBe(true);
		});

		test("valid bool constraint with && passes", () => {
			const input = `
import System
func ok = (int i: i >= 0 && i < 10) {
    Console.write("ok")
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		// The next cases document a real limitation: the flow analysis that proves
		// a buffer index is in bounds tracks while-loop conditions and direct
		// reassignments, but it does NOT narrow a value inside an `if x != -1`
		// branch (nor `if x > -1` / `if 0 <= x`). A linked-list container needs a
		// `-1` null sentinel for its empty head/tail and would guard every
		// dereference with `if head != -1`; because that guard is ignored, that
		// natural form cannot be used. The workaround is to guard with
		// `if head >= 0` instead — the checker narrows THAT form (it matches the
		// constraint's `i >= 0` half), which is how an O(1) linked list can be
		// written today.
		test("buffer index guarded by `if x != -1` is still rejected", () => {
			const input = `
import System
func caller = () {
    var Buffer<int> data = Buffer<int>()
    data.alloc_int(10)
    var int head = -1
    if head != -1 {
        data.store_int(head, 1)
    }
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
		});

		test("buffer index guarded by `if x >= 0` is accepted", () => {
			// The workaround for the case above: `>= 0` is narrowed by the flow
			// analysis, so a -1-initialized local can be used as an index inside
			// an `if x >= 0` branch. This is the form an O(1) linked-list container
			// (head/tail null sentinels) must use.
			const input = `
import System
func caller = () {
    var Buffer<int> data = Buffer<int>()
    data.alloc_int(10)
    var int head = -1
    if head >= 0 {
        data.store_int(head, 1)
    }
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("buffer index from a loaded value is accepted", () => {
			// Data-dependent indices (a "pointer" loaded from another buffer) are
			// also fine, so an index stored in a buffer and reloaded (rather than
			// kept in a -1-capable local) needs no guard at all.
			const input = `
import System
func caller = () {
    var Buffer<int> data = Buffer<int>()
    data.alloc_int(10)
    var Buffer<int> ptrs = Buffer<int>()
    ptrs.alloc_int(10)
    ptrs.store_int(0, 5)
    var int n = ptrs.load_int(0)
    data.store_int(n, 1)
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});
	});

	describe("field constraints", () => {
		test("constructor with violating argument errors", () => {
			const input = `
struct Foo {
    var int x: x > 5
}
func caller = () {
    var Foo f = Foo(2)
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
		});

		test("constructor with satisfying argument passes", () => {
			const input = `
struct Foo {
    var int x: x > 5
}
func caller = () {
    var Foo f = Foo(10)
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("default value satisfying constraint passes", () => {
			const input = `
struct Foo {
    var int x: x > 5 = 12
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("default value violating constraint errors", () => {
			const input = `
struct Foo {
    var int x: x > 5 = 2
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
		});

		test("field assignment violating constraint errors", () => {
			const input = `
struct Foo {
    var int x: x > 5
}
func caller = () {
    var Foo f = Foo(10)
    f.x = 2
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
		});

		test("field assignment satisfying constraint passes", () => {
			const input = `
struct Foo {
    var int x: x > 5
}
func caller = () {
    var Foo f = Foo(10)
    f.x = 20
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});
	});

	describe("variable constraints", () => {
		test("declaration with satisfying default passes", () => {
			const input = `
func test = () {
    var int x: x > 5 = 10
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("declaration with violating default errors", () => {
			const input = `
func test = () {
    var int x: x > 5 = 2
}
`;
			const parsed = parse(input);
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
		});

		test("reassignment violating constraint errors", () => {
			const input = `
func test = () {
    var int x: x > 5 = 10
    x = 2
}
`;
			const parsed = parse(input);
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
		});

		test("reassignment satisfying constraint passes", () => {
			const input = `
func test = () {
    var int x: x > 5 = 10
    x = 20
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("constraint with wrong type errors", () => {
			const input = `
import System
pub func main = () {
    var int x: x > "abc" = 5
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.some((e) => e.message.includes("Type mismatch"))).toBe(true);
		});

		test("constraint that is not boolean errors", () => {
			const input = `
import System
pub func main = () {
    var int x: x + 1 = 5
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.some((e) => e.message.includes("boolean expression"))).toBe(true);
		});

		test("compound constraint satisfied passes", () => {
			const input = `
func test = () {
    var int x: x > 0 && x < 100 = 50
}
`;
			const parsed = parse(input);
			expect(parsed.errors).toEqual([]);
		});

		test("compound constraint violated errors", () => {
			const input = `
func test = () {
    var int x: x > 0 && x < 100 = 200
}
`;
			const parsed = parse(input);
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
		});
	});
});
