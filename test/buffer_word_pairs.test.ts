import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// PERF_PLAN item 14: Buffer's T_SIZE-aware slot family (load/store/replace/
// move/shift/load_from) copies 8 < T_SIZE <= 16 elements as one ldp/stp word
// pair instead of calling memcpy (+ memset for the move/shift zero). The
// dispatch folds at monomorphization, so a 16-byte element splices as
// straight-line pair moves — pinned here at the emitted-code level and at the
// runtime level (both backends).

function build_aarch64(source: string): string {
	const parsed = parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	return build(parsed.root, { arch: "aarch64", audit: false }).code;
}

const PAIR_PROGRAM = `
struct Pair {
	var int v
}
var List<Pair> lst = List<Pair>()
var i = 0
while i < 6; i += 1 {
	lst.push(Pair(i * 2))
}
var j = 0
while j < lst.length; j += 1 {
	var p = Pair(j * 3)
	lst.set_or_panic(j, mv p)
}
var total = 0
j = 0
while j < lst.length; j += 1 {
	total = total + lst.at_or_panic(j).v
}
Console.write("\\{total}\\n")
var last = lst.pop()
Console.write("\\{last.v}\\n")
Console.write("\\{lst.length}\\n")
var lst2 = lst.copy()
Console.write("\\{lst2.at_or_panic(0).v + lst2.at_or_panic(1).v}\\n")
`;

describe("buffer word pairs (T_SIZE <= 16)", () => {
	test("16-byte elements round-trip through set/at/pop/copy", async () => {
		// fill v = 2i; replace sweep v = 3j → sum = 3*(0+..+5) = 45;
		// pop returns v = 15, length drops to 5; the copy's first two
		// slots sum to 0 + 3 = 3.
		await build_and_check_output(PAIR_PROGRAM, "buffer_word_pairs_roundtrip", "45\n15\n5\n3\n");
	});

	test("the spliced copies are pair moves, not memcpy calls", () => {
		const code = build_aarch64(PAIR_PROGRAM);
		// T_SIZE == 16 folds the stride to a shift...
		expect(code).toContain("lsl x1, x1, #4\n");
		// ...and the spliced slot copies are the pair arms: replace/store
		// loads the value's address (x2) into the slot, load feeds the sret
		// buffer (x8) from the slot, move additionally zeroes the slot —
		// each an adjacent ldp/stp (or ldp/stp/stp) sequence that only the
		// pair arm emits.
		expect(code).toContain("ldp x9, x10, [x2]\nstp x9, x10, [x0]\n");
		expect(code).toContain("ldp x9, x10, [x0]\nstp x9, x10, [x8]\n");
		expect(code).toContain("ldp x9, x10, [x5]\nstp x9, x10, [x8]\nstp xzr, xzr, [x5]\n");
		// The folded replace splice's taken path must not reach memcpy: the
		// only memcpy left in the Pair bodies is the unreachable tail.
		const pair_start = code.indexOf("_buffer_replace_T_pair");
		const pair_end = code.indexOf("_buffer_replace_T_end", pair_start);
		expect(pair_start).toBeGreaterThan(-1);
		expect(pair_end).toBeGreaterThan(pair_start);
		expect(code.slice(pair_start, pair_end)).not.toContain("bl _memcpy");
	});
});
