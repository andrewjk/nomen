import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports, { parse_program } from "./parse_with_imports";

// `ref` element borrows of STRING values — the slot-store gap, closed
// (FOLLOWUP.md carried the design). A List/Map slot holds a fat,
// container-OWNED `nomen_string` pair, so a mutable alias must WRITE
// THROUGH: the new pair is materialized into a temp first (the RHS may
// read the alias: `s = s.replace_first(...)`), the displaced pair is
// reclaimed, and the pair is stored into the slot. The displaced free is
// unconditionally sound here — List/Map slots own their elements
// (push/set dup) — unlike a `ref string` PARAM, whose caller-side
// ownership the callee cannot know (that store leaks by convention).
//
// Runtime tests run on BOTH backends with the leak auditor on: every
// displaced pair must balance.

describe("string element borrow (runtime, both backends)", () => {
	test("a write through a List slot borrow is visible to the container", async () => {
		await build_and_check_output(
			`
import System
pub func main = (Init init) {
	var List<string> ss = List<string>()
	ss.push("first")
	ref string s = ss.at(0)
	Console.write(s)
	s = "second"
	Console.write(" ")
	Console.write(s)
	Console.write(" ")
	Console.write(ss.at_or(0, "?"))
}
`,
			"string_elem_borrow_list_store",
			"first second second",
			true,
		);
	});

	test("a self-reading store keeps the old pair readable across the RHS", async () => {
		// `s = s + "-more"` reads the alias on the RHS; the store must
		// materialize the new pair into a temp BEFORE freeing the displaced
		// one (freeing first would free what the RHS just read — the exact
		// ordering the slot-store convention exists for).
		await build_and_check_output(
			`
import System
pub func main = (Init init) {
	var List<string> ss = List<string>()
	ss.push("head")
	ref string s = ss.at(0)
	s = s + "-more"
	s = s + "-more"
	Console.write(s)
	Console.write(" ")
	Console.write(ss.at_or(0, "?"))
}
`,
			"string_elem_borrow_self_read",
			"head-more-more head-more-more",
			true,
		);
	});

	test("repeated stores in a loop stay balanced", async () => {
		await build_and_check_output(
			`
import System
pub func main = (Init init) {
	var List<string> ss = List<string>()
	ss.push("seed")
	ref string s = ss.at(0)
	var int i = 0
	while i < 5; i += 1 {
		s = "iter\\{i}"
	}
	Console.write(s)
	Console.write(" ")
	Console.write(ss.at_or(0, "?"))
}
`,
			"string_elem_borrow_loop_store",
			"iter4 iter4",
			true,
		);
	});

	test("a Map value borrow stores into the map's own slot", async () => {
		await build_and_check_output(
			`
import System
pub func main = (Init init) {
	var Map<int, string> m = Map<int, string>()
	m.set(1, "one")
	ref string v = m.get_or_panic(1)
	v = "uno"
	Console.write(v)
	Console.write(" ")
	Console.write(m.get_or(1, "?"))
}
`,
			"string_elem_borrow_map_store",
			"uno uno",
			true,
		);
	});
});

describe("string element borrow (emitted shape)", () => {
	test("the store materializes a temp, frees the displaced pair, writes through", () => {
		const parsed = parse_program(`
import System
pub func main = (Init init) {
	var List<string> ss = List<string>()
	ss.push("a")
	ref string s = ss.at(0)
	s = "b"
	Console.write(s)
}
`);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "c", audit: false });
		expect(result.errors ?? []).toEqual([]);
		// The alias is the slot pointer; the store is temp-first + free + pair store.
		expect(result.code).toContain("nomen_string *s = List_string_slot_ptr(&ss, 0L);");
		expect(result.code).toMatch(
			/nomen_string _store_\d+ = nomen_str_dup\(nomen_str_lit\("b", 1\)\);\nfree\(\(\*s\)\.ptr\);\n\*s = _store_\d+;/,
		);
	});
});

describe("string element borrow (checker)", () => {
	test("a set through the container after the lookup invalidates a string borrow", () => {
		const parsed = parse_with_imports(`
var List<string> ss = List<string>()
ss.push("a")
ref string s = ss.at(0)
ss.push("b")
Console.write(s)
`);
		expect(parsed.errors.some((e) => e.message.includes("invalidated"))).toBe(true);
	});

	test("'for ref' over a List stays rejected (the array writeback shape doesn't transfer)", () => {
		const parsed = parse_with_imports(`
var List<string> ss = List<string>()
ss.push("a")
for ref s of ss {
	Console.write(s)
}
`);
		expect(parsed.errors.some((e) => e.message.includes("'ref' iteration is not supported"))).toBe(
			true,
		);
	});
});
