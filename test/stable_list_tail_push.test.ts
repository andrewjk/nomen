import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// PERF_PLAN item 17 (minor batch): StableList's non-in-place tail push used to
// relay through a one-slot `stage` buffer — the typed store landed in the
// stage (deep-copy semantics), then a raw push_tail byte-moved stage → chunk
// (memcpy) and zeroed the stage (memset). The tail push now stores the value
// DIRECTLY into the chunk slot through a transient Buffer view
// (`Buffer.store_in_slab`: init_view → the mono'd `store` → clear_view), so
// the staging slot, the byte relay, and its call pair are gone. The view is a
// FIELD carrier, not a local: an owning Buffer local is auto-destroyed at
// scope exit and would free the borrowed slab. Pinned here at the runtime
// level (both backends, audit on — strings and mv structs across the chunk
// boundary) and at the emitted-code level (the direct view store, no relay).

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
	var string tag
	var int x
}
// Strings across the chunk boundary, donor spelling (the non-producer path).
var StableList<string> names = StableList<string>()
var i = 0
while i < 300; i += 1 {
	var s = "n\\{i}"
	names.push(mv s)
}
var first = names.at_or_panic(0)
var last = names.at_or_panic(299)
var total = 0
var j = 0
while j < names.length; j += 1 {
	total += names.at_or_panic(j).length
}
Console.write("\\{first} \\{last} \\{total} \\{names.length}\\n")

// mv structs with string fields across the boundary, donor spelling.
var StableList<Rec> recs = StableList<Rec>()
i = 0
while i < 300; i += 1 {
	var r = Rec("r\\{i}", i)
	recs.push(mv r)
}
var sum = 0
j = 0
while j < recs.length; j += 1 {
	sum += recs.at_or_panic(j).x
}
Console.write("\\{recs.at_or_panic(256).tag} \\{sum} \\{recs.length}\\n")

// Producer spelling (in-place path) still reaches directory chunks.
var StableList<string> prods = StableList<string>()
i = 0
while i < 300; i += 1 {
	prods.push("p\\{i}")
}
Console.write("\\{prods.at_or_panic(299)} \\{prods.length}\\n")

// Int elements (trivially destructible).
var StableList<int> nums = StableList<int>()
i = 0
while i < 300; i += 1 {
	var v = i * 2
	nums.push(mv v)
}
var nsum = 0
j = 0
while j < nums.length; j += 1 {
	nsum += nums.at_or_panic(j)
}
Console.write("\\{nsum} \\{nums.length}\\n")
`;

describe("StableList tail push stores through the view", () => {
	test("strings, mv structs, producers, ints across the chunk boundary", async () => {
		// 300 elements = chunk 0 (256) + one directory chunk (44 filled).
		// "n0" "n299" total 1090 (20 + 270 + 800) len 300; "r256" sum 44850;
		// producer "p299" 300; ints sum 2*(0..299) = 89700.
		await build_and_check_output(
			PROGRAM,
			"stable_list_tail_view",
			"n0 n299 1090 300\nr256 44850 300\np299 300\n89700 300\n",
		);
	});

	test("the aarch64 tail push calls the view store, not a stage relay", () => {
		const code = build_aarch64(PROGRAM);
		// The only caller of the view store is push's tail branch.
		expect(code).toContain("bl StableList_string_ensure_chunk");
		expect(code).toContain("bl Buffer_string_store_in_slab");
		// No per-push byte relay: the old flat-tail push_tail did
		// memcpy + memset against the stage slot.
		expect(code).not.toContain("push_tail");
		// The view store's body holds the specialized string store (strdup),
		// not a raw stage byte move.
		const view_start = code.indexOf("Buffer_string_store_in_slab:");
		expect(view_start).toBeGreaterThan(-1);
		const next_fn = code.indexOf("\n.p2align", view_start);
		const view_body = code.slice(view_start, next_fn > view_start ? next_fn : undefined);
		expect(view_body).not.toContain("bl _memcpy");
	});

	test("the C tail push calls the view store, not a stage relay", () => {
		const code = build_c(PROGRAM);
		expect(code).not.toContain("push_tail");
		// The view store is called with the stage field carrier (a field,
		// never a local — a local owning Buffer is auto-destroyed).
		expect(code).toContain("Buffer_string_store_in_slab(&self->stage");
		const start = code.indexOf("void StableList_string_push");
		expect(start).toBeGreaterThan(-1);
		const end = code.indexOf("\nlong StableList_string_reserve", start);
		const body = code.slice(start, end > start ? end : undefined);
		expect(body).toContain("StableList_string_ensure_chunk");
		expect(body).toContain("Buffer_string_store_in_slab");
	});
});
