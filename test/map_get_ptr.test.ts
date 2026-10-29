import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports, { parse_program } from "./parse_with_imports";

// `Map.get_ptr` — the VALUE SLOT BORROW (PERF_PLAN item 4, the has+get
// fusion). One probe returns the mapped slot's address (`Buffer.slot_ptr`
// for Map values), so the LRU hot loop's `has` + `get` pair (two full
// probes) and the owning-specialized deep copy on every read of a
// container-bearing value both collapse into a single aliasing probe.
//
// `ptr` returns are library-only, so safe code reaches the primitive
// through the ELEMENT BORROW rewrite: `ref TV v = map.get_or_panic(k)`
// lowers to `get_ptr(k)` — the same lowering `ref T x = list.at(i)` gets
// from `slot_ptr`. The trap-on-absent contract carries over verbatim, so
// the rewrite is semantics-preserving. Runtime tests run on BOTH backends
// with the leak auditor on.

describe("Map element borrow (runtime, both backends)", () => {
	test("ref binding aliases the slot: a write through it is visible to get", async () => {
		const input = `
import System

pub func main = (Init init) {
	var m = Map<string, int>()
	m.set("a", 1)
	m.set("b", 2)
	ref int v = m.get_or_panic("a")
	v = 10
	Console.write("\\{m.get("a")} \\{m.get("b")}")
}
`;
		await build_and_check_output(input, "map_elem_borrow_alias", "10 2", true);
	});

	test("compound assignment writes through the borrow", async () => {
		const input = `
import System

pub func main = (Init init) {
	var m = Map<string, int>()
	m.set("a", 1)
	ref int v = m.get_or_panic("a")
	v += 5
	Console.write("\\{m.get("a")}")
}
`;
		await build_and_check_output(input, "map_elem_borrow_compound", "6", true);
	});

	test("struct value: the borrow skips the per-read deep copy", async () => {
		// A Map<int, Holder> whose value owns a List: an owning read
		// (`get_or_panic` bound to a var) deep-copies the container on every
		// lookup; the ref binding aliases the slot, so a write through the
		// borrow is the slot's own state and no copy is made. Reads go
		// through `at_or` (contract-free) so the bounds verifier is not the
		// thing under test.
		const input = `
import System

mv struct Holder {
	var vals = List<int>()
}

pub func main = (Init init) {
	var m = Map<int, Holder>()
	var h = Holder()
	h.vals.push(7)
	m.set(5, mv h)
	ref Holder slot = m.get_or_panic(5)
	slot.vals.push(9)
	var Holder copy = m.get_or_panic(5)
	Console.write("\\{copy.vals.at_or(0, -1)} \\{copy.vals.at_or(1, -1)} \\{copy.vals.length}")
}
`;
		await build_and_check_output(input, "map_elem_borrow_struct_value", "7 9 2", true);
	});

	test("read-only alias: reads see the live slot without copying", async () => {
		const input = `
import System

pub func main = (Init init) {
	var m = Map<int, int>()
	var int i = 0
	while i < 100; i += 1 {
		m.set(i, i * 2)
	}
	var int sum = 0
	var int j = 0
	while j < 100; j += 1 {
		ref int v = m.get_or_panic(j)
		sum += v
	}
	Console.write("\\{sum}")
}
`;
		// sum = 2 * (0+1+...+99) = 9900.
		await build_and_check_output(input, "map_elem_borrow_readonly", "9900", true);
	});

	test("string value element borrows are rejected", () => {
		const parsed = parse_with_imports(`
var m = Map<int, string>()
m.set(1, "a")
ref string s = m.get_or_panic(1)
Console.write(s)
`);
		expect(parsed.errors.some((e) => e.message.includes("string values are not supported"))).toBe(
			true,
		);
	});

	test("a set through the map after the lookup invalidates the borrow", () => {
		const parsed = parse_with_imports(`
var m = Map<string, int>()
m.set("a", 1)
ref int v = m.get_or_panic("a")
m.set("b", 2)
Console.write("\\{v}")
`);
		expect(parsed.errors.some((e) => e.message.includes("invalidated"))).toBe(true);
	});
});

// The fusion contract in the emitted code: the get_ptr body probes ONCE
// (one find_slot call), never routes through the copying `load`, and traps
// on an absent key; the ref-binding site calls get_ptr directly.
describe("Map.get_ptr (emitted shape)", () => {
	test("C backend: one probe, no deep-copy load", () => {
		const input = `
import System

pub func main = (Init init) {
	var m = Map<int, int>()
	m.set(1, 2)
	ref int v = m.get_or_panic(1)
	Console.write("\\{v}")
}
`;
		const parsed = parse_program(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", audit: false });
		expect(result.errors ?? []).toEqual([]);
		// The element-borrow rewrite reached the primitive.
		expect(result.code).toContain("long* Map_int_int_get_ptr(");
		// Slice the definition's body: from its signature (prototypes precede
		// definitions) to the trap tail that closes it.
		const sig_idx = result.code.lastIndexOf("long* Map_int_int_get_ptr(");
		const end_idx = result.code.indexOf("exit(EXIT_FAILURE)", sig_idx);
		const get_ptr_fn = result.code.substring(sig_idx, end_idx);
		expect(get_ptr_fn).toBeDefined();
		// One probe: exactly one find_slot call in the body.
		expect(get_ptr_fn.split("find_slot").length - 1).toBe(1);
		// The trap-on-absent contract travels with the rewrite.
		expect(get_ptr_fn).toContain("key not found");
		// The borrow aliases the slot: no copying `load` in the read path.
		expect(get_ptr_fn).toContain("Buffer_int_slot_ptr");
		expect(get_ptr_fn).not.toContain("Buffer_int_load(");
		// The ref binding aliases: the site calls the primitive, no copy.
		expect(result.code).toContain("Map_int_int_get_ptr(&");
	});
});
