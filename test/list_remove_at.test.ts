import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// PERF_PLAN item 17 (minor batch): List.remove_at_or_panic's backward shift
// was a per-element Buffer.shift loop — one memcpy + one memset call per
// shifted element (the mv specializations add a displaced reclaim/free per
// element on top). The loop is now ONE Buffer.move_range call: a single
// memmove over the whole tail plus one memset of the slot the destination
// never covers (the contiguous deletion shape's tail slot is the only
// source slot the move leaves behind). Pinned here at the runtime level
// (both backends, audit on — every removed element must be released exactly
// once) and at the emitted-code level (the bulk primitive, not a shift loop).

function build_aarch64(source: string): string {
	const parsed = parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	return build(parsed.root, { arch: "aarch64", audit: false }).code;
}

function build_c(source: string): string {
	const parsed = parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	return build(parsed.root, { arch: "c", audit: false }).code;
}

const PROGRAM = `
mv struct Rec {
	var string s
	var int x
}
var lst = List<string>()
lst.push("a")
lst.push("b")
lst.push("c")
lst.push("d")
lst.push("e")
var mid = lst.remove_at_or_panic(2)
Console.write("\\{mid} \\{lst.length}\\n")
var i = 0
while i < lst.length; i += 1 {
	Console.write(lst.at_or_panic(i))
}
Console.write("\\n")
var first = lst.remove_at_or_panic(0)
Console.write("\\{first} \\{lst.at_or_panic(0)}\\n")
var last = lst.remove_at_or_panic(lst.length - 1)
Console.write("\\{last} \\{lst.length}\\n")

var recs = List<Rec>()
var k = 0
while k < 4; k += 1 {
	recs.push(Rec("r\\{k}", k))
}
var taken = recs.remove_at_or_panic(1)
Console.write("\\{taken.s} \\{taken.x}\\n")
Console.write("\\{recs.length}\\n")
var acc = 0
while recs.length > 0 {
	var t = recs.remove_at_or_panic(0)
	acc += t.x
}
Console.write("\\{acc}\\n")

var nums = List<int>()
var j = 0
while j < 10; j += 1 {
	nums.push(j)
}
var m = 0
while m < 3; m += 1 {
	var dead = nums.remove_at_or_panic(1)
	if dead == 100 {
		Console.write("unreachable")
	}
}
var sum = 0
j = 0
while j < nums.length; j += 1 {
	sum += nums.at_or_panic(j)
}
Console.write("\\{sum} \\{nums.at_or_panic(0)}\\n")
`;

describe("list remove_at bulk tail move", () => {
	test("middle/front/last removals round-trip (strings, mv structs, ints)", async () => {
		// "c" out of [a..e] (2 shifted); front removal shifts 3; the last-index
		// removal shifts none; Rec r1 out of [r0..r3] then drain at 0
		// (0+2+3 = 5); three index-1 removals from [0..9] leave [0,4..9], sum 39.
		await build_and_check_output(
			PROGRAM,
			"list_remove_at_bulk",
			"c 4\nabde\na b\ne 2\nr1 1\n3\n5\n39 0\n",
		);
	});

	test("the aarch64 removal lowers to the bulk memmove + memset splice", () => {
		const code = build_aarch64(PROGRAM);
		const start = code.indexOf("List_string_remove_at_or_panic");
		expect(start).toBeGreaterThan(-1);
		const end = code.indexOf("\n_int_List_string_remove_at_or_panic", start);
		const body = code.slice(start, end > start ? end : undefined);
		// The bulk primitive's splice: the count guard, one memmove, one memset.
		expect(body).toContain("bl _memmove");
		expect(body).toContain("bl _memset");
		// The whole-tail splice is linear — no per-element shift loop remains
		// (a backward shift loop would carry its own branch-back label).
		expect(body).not.toContain("Buffer_shift_string");
	});

	test("the C removal calls the bulk move_range helper", () => {
		const code = build_c(PROGRAM);
		expect(code).toContain("Buffer_string_move_range");
		const start = code.indexOf("List_string_remove_at_or_panic");
		expect(start).toBeGreaterThan(-1);
		const body = code.slice(start, code.indexOf("move_range", start) + 200);
		expect(body).toContain("move_range");
	});
});
