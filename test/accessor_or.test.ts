import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// The `_or` accessor family: every index/key-constrained accessor in the
// library has a bounds-checked variant — `<accessor>_or(i, fallback)` for
// "out of range / missing is an expected case" and `<accessor>_or_panic(i)`
// for "out of range / missing is a bug". They are the runtime-checked
// escape hatch for indices the constraint checker can't prove (see
// PERF.md gap 5 and PERF_RESPONSE.md).
//
// The panic paths exit with EXIT_FAILURE, which the run-based harness treats
// as a failure — so those are verified build-and-inspect style (the emitted
// code contains the panic message; the branch structure is the same guard
// the run paths exercise), mirroring test/control.test.ts.

describe("List at_or / at_or_panic", () => {
	test("at_or in-bounds returns the element", async () => {
		const input = `
var List<int> xs = List<int>()
xs.push(10)
xs.push(20)
Console.write("\\{xs.at_or(1, 0)}")
`;
		await build_and_check_output(input, "list_at_or_hit", "20");
	});

	test("at_or out-of-bounds and negative return the fallback", async () => {
		const input = `
var List<int> xs = List<int>()
xs.push(10)
xs.push(20)
Console.write("\\{xs.at_or(2, -1)} \\{xs.at_or(-1, -2)} \\{xs.at_or(0, -3)}")
`;
		await build_and_check_output(input, "list_at_or_miss", "-1 -2 10");
	});

	test("at_or on an empty list returns the fallback", async () => {
		const input = `
var List<int> xs = List<int>()
Console.write("\\{xs.at_or(0, 42)}")
`;
		await build_and_check_output(input, "list_at_or_empty", "42");
	});

	test("at_or with string elements", async () => {
		const input = `
var List<string> xs = List<string>()
xs.push("real")
Console.write("\\{xs.at_or(0, "fallback")}\\{xs.at_or(5, "fallback")}")
`;
		await build_and_check_output(input, "list_at_or_string", "realfallback");
	});

	test("at_or_panic in-bounds returns the element", async () => {
		const input = `
var List<int> xs = List<int>()
xs.push(7)
Console.write("\\{xs.at_or_panic(0)}")
`;
		await build_and_check_output(input, "list_at_or_panic_hit", "7");
	});

	test("at_or_panic out-of-bounds emits the trap", () => {
		const input = `
var List<int> xs = List<int>()
xs.push(7)
var int i = 0
i += 2
Console.write("\\{xs.at_or_panic(i)}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		for (const arch of ["aarch64", "c"] as const) {
			const result = build(parsed.root, { arch, audit: false });
			expect(result.code).toContain("index out of range");
		}
	});
});

// Array is intentionally excluded from the _or family for now: `.at` on
// arrays is special-cased to direct indexing in both backends (never a
// method call), and a general Array method with a Nomen body exposes
// pre-existing receiver-convention gaps — see FOLLOWUP.md "Array methods
// with Nomen-level bodies".

describe("string at_or / at_or_panic", () => {
	test("at_or in-bounds and out-of-bounds", async () => {
		const input = `
var string s = "abc"
Console.write("\\{s.at_or(1, '-')}\\{s.at_or(3, '!')}")
`;
		await build_and_check_output(input, "string_at_or", "b!");
	});

	test("at_or_panic in-bounds returns the char", async () => {
		const input = `
var string s = "abc"
Console.write("\\{s.at_or_panic(2)}")
`;
		await build_and_check_output(input, "string_at_or_panic_hit", "c");
	});

	test("at_or_panic out-of-bounds emits the trap", () => {
		const input = `
var string s = "abc"
var int i = 0
i += 4
Console.write("\\{s.at_or_panic(i)}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		for (const arch of ["aarch64", "c"] as const) {
			const result = build(parsed.root, { arch, audit: false });
			expect(result.code).toContain("index out of range");
		}
	});
});

describe("LinkedList at_or / at_or_panic", () => {
	test("at_or in-bounds and out-of-bounds", async () => {
		const input = `
var LinkedList<int> xs = LinkedList<int>()
xs.add(1)
xs.add(2)
Console.write("\\{xs.at_or(1, 0)} \\{xs.at_or(9, -1)}")
`;
		await build_and_check_output(input, "linked_list_at_or", "2 -1");
	});

	test("at_or_panic in-bounds returns the element", async () => {
		const input = `
var LinkedList<int> xs = LinkedList<int>()
xs.add(5)
Console.write("\\{xs.at_or_panic(0)}")
`;
		await build_and_check_output(input, "linked_list_at_or_panic_hit", "5");
	});
});

describe("Map get_or_panic", () => {
	test("get_or_panic returns the value for an existing key", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(3, 30)
Console.write("\\{m.get_or_panic(3)}")
`;
		await build_and_check_output(input, "map_get_or_panic_hit", "30");
	});

	test("get_or_panic on an existing key with value 0 is unambiguous", async () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(1, 0)
Console.write("\\{m.get_or_panic(1)}")
`;
		await build_and_check_output(input, "map_get_or_panic_zero", "0");
	});

	test("get_or_panic missing key emits the trap", () => {
		const input = `
var Map<int, int> m = Map<int, int>()
m.set(3, 30)
Console.write("\\{m.get_or_panic(4)}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		for (const arch of ["aarch64", "c"] as const) {
			const result = build(parsed.root, { arch, audit: false });
			expect(result.code).toContain("key not found");
		}
	});
});

describe("Set get_or / get_or_panic", () => {
	test("get_or returns the stored value for a member", async () => {
		const input = `
var Set<int> s = Set<int>()
s.add(11)
Console.write("\\{s.get_or(11, 0)} \\{s.get_or(99, -1)}")
`;
		await build_and_check_output(input, "set_get_or", "11 -1");
	});

	test("get_or_panic in-bounds returns the member", async () => {
		const input = `
var Set<int> s = Set<int>()
s.add(11)
Console.write("\\{s.get_or_panic(11)}")
`;
		await build_and_check_output(input, "set_get_or_panic_hit", "11");
	});

	test("get_or_panic missing member emits the trap", () => {
		const input = `
var Set<int> s = Set<int>()
s.add(11)
Console.write("\\{s.get_or_panic(12)}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		for (const arch of ["aarch64", "c"] as const) {
			const result = build(parsed.root, { arch, audit: false });
			expect(result.code).toContain("value not found in set");
		}
	});
});
