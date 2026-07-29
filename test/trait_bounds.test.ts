import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

// Trait bounds on struct type params: `struct Container<T: Control>` constrains
// `T` to conform to a trait. Exercises parsing (`: Bound` after a type param,
// `+`-separated multiple bounds), checking (each bound is a known trait), and
// validation at monomorphization (each concrete type arg conforms to the bound).
// Calling bound methods on `T` inside the struct body is a separate (deeper)
// feature; these tests cover the syntax + conformance validation.

describe("trait bounds on struct type params", () => {
	test("bounded param accepts a conforming type arg and builds", async () => {
		// A field-less bounded struct instantiates with a conforming type
		// arg. The bound is validated at monomorphization (`Marker<Dog>()`
		// triggers the conformance check). Kept field-less to isolate the
		// bound feature from the separate generic-struct-field-storage path.
		const input = `
trait Named {
	func id = (self, out int)
}

struct Dog: Named {
	func id = (self, out int) {
		return 5
	}
}

struct Marker<T: Named> {
}

var Marker<Dog> m = Marker<Dog>()
Console.write("ok")
`;
		await build_and_check_output(input, "trait_bound_ok", "ok");
	});

	test("multiple bounds (`T: A + B`) accept a type conforming to both", async () => {
		const input = `
trait Named {
	func id = (self, out int)
}
trait Counted {
	func count = (self, out int)
}

struct Widget: Named, Counted {
	func id = (self, out int) {
		return 7
	}
	func count = (self, out int) {
		return 3
	}
}

struct Box<T: Named + Counted> {
}

var Box<Widget> b = Box<Widget>()
Console.write("ok")
`;
		await build_and_check_output(input, "trait_bound_multi", "ok");
	});

	test("bound is optional per param (mixed bounded/unbounded)", () => {
		// `Pair<K, V: Named>` — K is free, V must conform. Parsing only here.
		const input = `
trait Named {
	func id = (self, out int)
}

struct Pair<K, V: Named> {
	pub var K key
	pub var V value
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});
});

describe("trait bound errors", () => {
	test("non-conforming type arg violates the bound", () => {
		const input = `
trait Named {
	func id = (self, out int)
}

struct Bone {}

struct Holder<T: Named> {
	pub var T item
}

var Holder<Bone> h = Holder<Bone>(Bone())
`;
		const parsed = parse(input);
		expect(parsed.errors.some((e) => e.message.includes("does not conform to bound 'Named'"))).toBe(
			true,
		);
	});

	test("primitive type arg violates the bound", () => {
		const input = `
trait Named {
	func id = (self, out int)
}

struct Holder<T: Named> {
	pub var T item
}

var Holder<int> h = Holder<int>(0)
`;
		const parsed = parse(input);
		expect(parsed.errors.some((e) => e.message.includes("does not conform to bound 'Named'"))).toBe(
			true,
		);
	});

	test("unknown trait bound is rejected at the declaration", () => {
		const input = `
struct Holder<T: Contrloo> {
	pub var T item
}
`;
		const expected = [test_error(input, "Unknown trait bound: Contrloo", 2, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
