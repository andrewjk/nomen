import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports, { parse_raw } from "./parse_with_imports";

// The element-borrow READ positions (PERF_PLAN item 4, the remainder beyond
// the explicit `ref` binding): the for-of desugar and the hoisted receiver
// temp both take the ELEMENT BORROW when the shape admits it, so a
// container-bearing struct element stops paying the owning load's deep copy
// (fresh container init + slab memcpy per container field) per read.
//
// for x of list      →  ref-shaped binding over list.slot_ptr(i)
// list.at(i).field   →  a _recv_N slot alias, reads dereference the slot
//
// Both are policed to be semantics-invisible: any mutation the alias could
// observe (a body that references the iterated container, a nested function,
// a ref-self call rooted at the temp or its container) keeps or reverts to
// the owning copy, so the elision never changes behavior. Runtime tests run
// on BOTH backends with the leak auditor on.

function build_aarch64(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	return build(parsed.root, { arch: "aarch64", audit: false }).code;
}

function build_c(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	return build(parsed.root, { arch: "c", audit: false }).code;
}

const STRUCTS = `
mv struct Rec {
	var tags = List<string>()
	var int id = 0
}

mv struct Outer {
	var items = List<string>()
	var int n = 0
}
`;

describe("for-of element borrow (runtime, both backends)", () => {
	test("reads see every element without the per-iteration copy", async () => {
		await build_and_check_output(
			`
import System
${STRUCTS}
pub func main = (Init init) {
	var List<Rec> rs = List<Rec>()
	for i of 0..4 {
		var Rec r = Rec()
		r.id = i * 11
		r.tags.push("t\\{i}")
		rs.push(mv r)
	}
	var int total = 0
	var string names = ""
	for x of rs {
		total += x.id
		names = names + x.tags.at_or(0, "?")
	}
	Console.write("\\{total} \\{names}")
}
`,
			"for_of_borrow_reads",
			"66 t0t1t2t3",
			true,
		);
	});

	test("a mutating body keeps the owning copy (reference gate)", async () => {
		// The body references the container, so the binding stays an owning
		// per-iteration copy: the pops mid-loop must not dangle an alias and
		// the reads must see the copied values (today's semantics, pinned).
		await build_and_check_output(
			`
import System
${STRUCTS}
pub func main = (Init init) {
	var List<Rec> rs = List<Rec>()
	for i of 0..4 {
		var Rec r = Rec()
		r.id = i
		rs.push(mv r)
	}
	var int n = 0
	for x of rs {
		n += x.id
		rs.pop()
	}
	Console.write("\\{n} \\{rs.length}")
}
`,
			"for_of_borrow_mutating_body",
			"1 2",
			true,
		);
	});

	test("StableList elements borrow too (stable-address container)", async () => {
		await build_and_check_output(
			`
import System
${STRUCTS}
pub func main = (Init init) {
	var StableList<Rec> rs = StableList<Rec>()
	for i of 0..299 {
		var Rec r = Rec()
		r.id = i % 7
		rs.push(mv r)
	}
	var int total = 0
	for x of rs {
		total += x.id
	}
	Console.write("\\{total}")
}
`,
			"for_of_borrow_stable_list",
			"892",
			true,
		);
	});

	test("element reads through a container param borrow the param's slots", async () => {
		await build_and_check_output(
			`
import System
${STRUCTS}
func sum_ids = (List<Rec> rs, out int) {
	var int total = 0
	for x of rs {
		total += x.id
	}
	return total
}
pub func main = (Init init) {
	var List<Rec> rs = List<Rec>()
	for i of 0..5 {
		var Rec r = Rec()
		r.id = i * 3
		rs.push(mv r)
	}
	Console.write("\\{sum_ids(rs)}")
}
`,
			"for_of_borrow_param_container",
			"30",
			true,
		);
	});
});

describe("for-of element borrow (emitted shape)", () => {
	const SRC = `
import System
${STRUCTS}
pub func main = (Init init) {
	var List<Rec> rs = List<Rec>()
	rs.push(Rec())
	var int total = 0
	for x of rs {
		total += x.id
	}
	Console.write("\\{total}")
}
`;

	test("the binding is the slot primitive inside the loop, not the copying load", () => {
		const c = build_c(SRC);
		expect(c).toContain("List_Rec_slot_ptr(&rs, __for_idx_x)");
		expect(c).not.toContain("List_Rec_at(&rs, __for_idx_x)");
		const a = build_aarch64(SRC);
		expect(a).toContain("List_Rec_slot_ptr");
		expect(a).not.toContain("bl List_Rec_at");
	});

	test("string elements keep the owning load", () => {
		const c = build_c(`
import System
pub func main = (Init init) {
	var List<string> ss = List<string>()
	ss.push("a")
	var string acc = ""
	for s of ss {
		acc = acc + s
	}
	Console.write(acc)
}
`);
		expect(c).not.toContain("List_string_slot_ptr(&ss, __for_idx_s");
		expect(c).toContain("List_string_at(&ss, __for_idx_s");
	});

	test("a body that references the container keeps the owning load", () => {
		const c = build_c(`
import System
${STRUCTS}
pub func main = (Init init) {
	var List<Rec> rs = List<Rec>()
	rs.push(Rec())
	var int n = 0
	for x of rs {
		n += x.id
		rs.pop()
	}
	Console.write("\\{n}")
}
`);
		expect(c).toContain("List_Rec_at(&rs, __for_idx_x");
		expect(c).not.toContain("List_Rec_slot_ptr(&rs, __for_idx_x");
	});
});

describe("receiver-temp element borrow (runtime, both backends)", () => {
	test("field reads through an element read see the slot", async () => {
		await build_and_check_output(
			`
import System
${STRUCTS}
pub func main = (Init init) {
	var List<Rec> rs = List<Rec>()
	for i of 0..2 {
		var Rec r = Rec()
		r.id = 10 + i
		r.tags.push("s\\{i}")
		rs.push(mv r)
	}
	var string acc = ""
	for i of 0..3 {
		acc = acc + "\\{rs.at_or(i, Rec()).id}:"
	}
	var int via_temp = rs.at_or(1, Rec()).id
	Console.write("\\{acc} \\{via_temp}")
}
`,
			"temp_borrow_field_reads",
			"10:11:0: 11",
			true,
		);
	});

	test("a mutation through the temp keeps the owning copy (revert)", async () => {
		// The chained push mutates through the hoisted alias, so the hoist
		// reverts to the owning temp and the write lands in the copy — the
		// element's tag count must stay 1 (today's lost-write semantics).
		await build_and_check_output(
			`
import System
${STRUCTS}
pub func main = (Init init) {
	var List<Rec> rs = List<Rec>()
	var Rec r0 = Rec()
	r0.tags.push("only")
	rs.push(mv r0)
	rs.at(0).tags.push("lost")
	Console.write("\\{rs.at_or(0, Rec()).tags.length} \\{rs.at_or(0, Rec()).tags.at_or(0, "?")}")
}
`,
			"temp_borrow_revert_mutation",
			"1 only",
			true,
		);
	});

	test("a Map value read through get_or_panic aliases the slot", async () => {
		await build_and_check_output(
			`
import System
${STRUCTS}
pub func main = (Init init) {
	var Map<int, Rec> m = Map<int, Rec>()
	var Rec r = Rec()
	r.id = 5
	m.set(1, mv r)
	Console.write("\\{m.get_or_panic(1).id}")
}
`,
			"temp_borrow_map_value",
			"5",
			true,
		);
	});
});

describe("receiver-temp element borrow (emitted shape)", () => {
	test("the temp is the slot alias; reads dereference it", () => {
		const c = build_c(`
import System
${STRUCTS}
pub func main = (Init init) {
	var List<Rec> rs = List<Rec>()
	rs.push(Rec())
	var int v = rs.at(0).id
	Console.write("\\{v}")
}
`);
		expect(c).toContain("struct Rec *_recv_0 = List_Rec_slot_ptr(&rs, 0L)");
		expect(c).toContain("_recv_0->id");
		expect(c).not.toContain("List_Rec_at(&rs, 0L)");
	});

	test("a ref-self call through the temp reverts it to the owning copy", () => {
		const c = build_c(`
import System
${STRUCTS}
pub func main = (Init init) {
	var List<Rec> rs = List<Rec>()
	rs.push(Rec())
	rs.at(0).tags.push("x")
	Console.write("\\{rs.length}")
}
`);
		expect(c).toContain("struct Rec _recv_0 = List_Rec_at(&rs, 0L)");
		expect(c).not.toContain("List_Rec_slot_ptr(&rs, 0L)");
	});

	test("a ref-self call on the container later in the statement reverts it", () => {
		const c = build_c(`
import System
${STRUCTS}
pub func main = (Init init) {
	var List<Rec> rs = List<Rec>()
	rs.push(Rec())
	rs.push(Rec())
	var int v = rs.at(0).id + rs.pop().id
	Console.write("\\{v}")
}
`);
		expect(c).toContain("List_Rec_at(&rs, 0L)");
		expect(c).not.toContain("List_Rec_slot_ptr(&rs, 0L)");
	});
});

describe("element-borrow checker guards (unchanged shapes)", () => {
	test("writes through the loop binding stay rejected (deep-const, both worlds)", () => {
		const parsed = parse_with_imports(`
${STRUCTS}
var List<Rec> rs = List<Rec>()
rs.push(Rec())
for x of rs {
	x.id = 5
}
`);
		expect(parsed.errors.some((e) => e.message.includes("Assignment to const"))).toBe(true);
	});
});
