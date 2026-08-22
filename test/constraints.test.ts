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

		test("for-loop variable is const — modification is rejected", () => {
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
			// Loop iterators are const by default, so `i += 1` is rejected before
			// the constraint check even runs — catching the mistake earlier.
			expect(parsed.errors.some((e) => e.message.includes("const"))).toBe(true);
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

		test("buffer index from a loaded value requires a guard", () => {
			// Data-dependent indices (a "pointer" loaded from another buffer)
			// can't be proven in bounds at compile time. Now that Buffer no
			// longer has the silent_core carve-out, this is a real OOB risk
			// and must be guarded explicitly (`if n >= 0 && n < data.cap`).
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
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(parsed.errors.some((e) => e.message.includes("cannot be verified"))).toBe(true);
		});

		test("buffer index from a loaded value with guard is accepted", () => {
			// Guard the data-dependent index with an explicit range check
			// against `data.cap` — the bound then verifies at compile time.
			const input = `
import System
func caller = () {
    var Buffer<int> data = Buffer<int>()
    data.alloc_int(10)
    var Buffer<int> ptrs = Buffer<int>()
    ptrs.alloc_int(10)
    ptrs.store_int(0, 5)
    var int n = ptrs.load_int(0)
    if n >= 0 && n < data.cap {
        data.store_int(n, 1)
    }
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

	describe("guard-clause bounds", () => {
		// A guard clause `if cond { return }` (or `{ break }`) whose body always
		// exits establishes the NEGATION of cond for the fall-through, so a
		// following indexed access verifies without an extra `&&` guard.
		test("disjunction return-guard verifies .at", () => {
			const input = `
import System
func probe = (List<int> list, int i, out int) {
    if i < 0 || i >= list.length { return 0 }
    return list.at(i)
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("break-guard inside a loop verifies .at", () => {
			const input = `
import System
func probe = (List<int> list, out int) {
    var int p = 0
    while p < list.length {
        if p >= list.length { break }
        return list.at(p)
    }
    return 0
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("single lower-bound return-guard carries into a later upper-bound if", () => {
			const input = `
import System
func probe = (List<int> list, int i, out int) {
    if i < 0 { return 0 }
    if i < list.length { return list.at(i) }
    return 0
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		// Two SEQUENTIAL single-return guards each establish their own
		// negated bound for the fall-through. Previously the second guard's
		// negation was suppressed because clone_status shallow-copied the
		// flow-bound arrays, leaking the applied bound back into the parent
		// and making the checker think the condition was provably true. The
		// deep-copy in clone_status fixes this.
		test("two sequential return-guards verify .at", () => {
			const input = `
import System
func probe = (List<int> list, int i, out int) {
    if i < 0 { return 0 }
    if i >= list.length { return 0 }
    return list.at(i)
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		// A guard clause must (re-)establish its negated bounds on a `var`
		// local that was REASSIGNED before the guard — even by an earlier
		// clamp. The if/else reconciliation copies the pre-if (cleared)
		// bounds for `var` values, so applying the negation before the copy
		// lost it; the guard-clause application now runs after the
		// reconciliation.
		test("return-guard after a clamp verifies .at on the clamped var", () => {
			const input = `
import System
func probe = (List<int> list, int start, out int) {
    var int i = start
    if i < 0 { i = 0 }
    if i < 0 || i >= list.length { return 0 }
    return list.at(i)
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("return-guard verifies .at on a never-reassigned var local", () => {
			const input = `
import System
func probe = (List<int> list, out int) {
    var int i = first_index(list)
    if i < 0 || i >= list.length { return 0 }
    return list.at(i)
}
func first_index = (List<int> list, out int) {
    return 0
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		// The natural clamp-then-guard style for string.slice: clamp both
		// ends, guard the ordering, and the slice's parameter constraints
		// discharge from the guard's negated bounds.
		test("clamp-then-guard verifies string.slice bounds", () => {
			const input = `
import System
func probe = (string text, int start, int end, out string) {
    var int s = start
    var int e = end
    if s < 0 { s = 0 }
    if e > text.length { e = text.length }
    if s > e { return text }
    return text.slice(s, e).to_string()
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});
	});

	describe("alias-through-arithmetic", () => {
		// `var int n = list.length` makes `n` an alias of `list.length`. An
		// access `list.at(n - 1)` (guarded by `n > 0`) should verify because
		// `n - 1 < list.length` reduces (via the alias) to
		// `list.length - 1 < list.length`, which always holds. The lower half
		// `n - 1 >= 0` is discharged by the `n > 0` guard through a partial
		// numeric interval (range_lower only).
		test("at(n - 1) where n aliases list.length, guarded n > 0", () => {
			const input = `
import System
func last = (List<int> list, out int) {
    var int n = list.length
    if n > 0 {
        return list.at(n - 1)
    }
    return 0
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("at(n - 1) on a fixed-size Array where n aliases arr.length", () => {
			const input = `
import System
func last = (Array<int> arr, out int) {
    var int n = arr.length
    if n > 0 {
        return arr.at(n - 1)
    }
    return 0
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		test("at(n - 1) on a string where n aliases s.length", () => {
			const input = `
import System
func last = (string s, out char) {
    var int n = s.length
    if n > 0 {
        return s.at(n - 1)
    }
    return 65 as char
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});

		// Without the `n > 0` guard, `n - 1` can be -1 on an empty collection,
		// so the lower-half constraint is rejected — a genuine OOB risk. With
		// alias-through-arithmetic plus the non-negative-length alias bound
		// (`var int n = list.length` records `n.range_lower = 0`), the checker
		// can now PROVE the access can be unsafe (`n - 1` can be -1) and emits
		// "not satisfied"; without that precision it emits "cannot be verified".
		// Either rejection is acceptable — the access must be rejected.
		test("at(n - 1) with no non-empty guard is rejected", () => {
			const input = `
import System
func last = (List<int> list, out int) {
    var int n = list.length
    return list.at(n - 1)
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
			expect(
				parsed.errors.some(
					(e) => e.message.includes("cannot be verified") || e.message.includes("not satisfied"),
				),
			).toBe(true);
		});
	});

	describe("return-contract bounds", () => {
		// A function with a return contract `out <= in_len` propagates an
		// inclusive upper bound onto its result at the call site. Combined
		// with a strict loop bound (`while j < end`), the existing transitive
		// logic proves `j < input.length` BEFORE the conservative off-by-one
		// "unsafe" check fires on the inherited inclusive bound. This is the
		// shape of `Regex.match`'s inner loop over `match_here`'s result.
		test("call-result bound + strict loop bound verifies .at", () => {
			const input = `
import System
func bounded = (string input, int i, int len, out int: out <= len) {
    return i
}
func collect = (string input, out string) {
    var int len = input.length
    var i = 0
    var result = ""
    while i <= len; i += 1 {
        if i > len { break }
        var int end = bounded(input, i, len)
        if end >= 0 {
            var int j = i
            while j < end; j += 1 {
                result = result + "\\{input.at(j)}"
            }
            break
        }
    }
    return result
}
`;
			const parsed = parse(input, get_library(core));
			expect(parsed.errors).toEqual([]);
		});
	});
});
