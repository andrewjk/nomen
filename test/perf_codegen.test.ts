import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import parse_with_imports from "./parse_with_imports";

// Codegen shape tests for the PERF.md Part 2 fixes, on the aarch64 backend:
//  - the monomorphized element-width dispatch (`cmp xN, #8 / b.gt …` chains
//    against a constant `mov xN, #T_SIZE`) is folded at substitution time,
//  - `Buffer.load_T` / `Buffer.store_T` are `inline` (raw-only bodies take
//    the naked-inline path, so no call frames in the accessor chain),
//  - `Map`/`Set` bucket indexing uses a power-of-two mask, not sdiv/msub.

function build_aarch64(source: string): string {
	const parsed = parse_with_imports(source);
	expect(parsed.errors).toEqual([]);
	return build(parsed.root, { arch: "aarch64", audit: false }).code;
}

describe("element-width dispatch folding", () => {
	test("Buffer load/store dispatch is folded for int elements", () => {
		const code = build_aarch64(`
var List<int> list = List<int>()
list.push(1)
list.push(2)
var int sum = 0
var int j = 0
while j < list.length {
	sum = sum + list.at(j)
	j = j + 1
}
Console.write("\\{sum}\\n")
`);
		// The dispatch head compares the constant width against 8 to pick
		// the copy path; for T_SIZE == 8 it must be gone everywhere.
		expect(code).not.toContain("cmp x3, #8\n");
		// The stride multiply folds to a shift for power-of-two sizes.
		expect(code).toContain("lsl x1, x1, #3\n");
	});

	test("folded dispatch still works for struct elements (copy path)", () => {
		// A wide struct element takes the memcpy path; T_SIZE (24) is not a
		// power of two so the multiply stays, but the branch chain must
		// resolve to the copy path.
		const code = build_aarch64(`
struct Pt {
	var int x
	var int y
}
var List<Pt> pts = List<Pt>()
pts.push(Pt(1, 2))
pts.push(Pt(3, 4))
var int j = 0
var int last_y = 0
while j < pts.length {
	last_y = pts.at(j).y
	j = j + 1
}
Console.write("\\{last_y}\\n")
`);
		expect(code).not.toContain("cmp x3, #8\n");
		expect(code).toContain("_memcpy");
	});
});

describe("inlined buffer accessors", () => {
	test("load_T and store_T are naked-inlined (no calls remain)", () => {
		const code = build_aarch64(`
var List<int> list = List<int>()
list.push(7)
list.push(9)
var int j = 0
var int v = 0
while j < list.length {
	v = list.at(j)
	j = j + 1
}
Console.write("\\{v}\\n")
`);
		expect(code).not.toContain("bl Buffer_int_load_T\n");
		expect(code).not.toContain("bl Buffer_int_store_T\n");
	});
});

describe("map mask indexing", () => {
	test("find_slot uses a mask, not division", () => {
		const code = build_aarch64(`
var Map<int, int> m = Map<int, int>()
m.set(1, 10)
m.set(2, 20)
Console.write("\\{m.get(2)}\\n")
`);
		// No division anywhere in the program (it contains no `/` operator),
		// so any sdiv would have to come from find_slot's bucket index.
		expect(code).not.toContain("sdiv");
		expect(code).not.toContain("msub");
	});

	test("map with string keys also avoids sdiv", () => {
		const code = build_aarch64(`
var Map<string, int> m = Map<string, int>()
m.set("a", 1)
m.set("b", 2)
Console.write("\\{m.get("b")}\\n")
`);
		expect(code).not.toContain("sdiv");
	});
});
