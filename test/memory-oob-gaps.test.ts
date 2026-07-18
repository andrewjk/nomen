import { describe, test, expect } from "vite-plus/test";

import parse_with_imports from "./parse_with_imports";

// Out-of-bounds memory access: the aarch64/C backends inline
// `Array.at` / `Array.set` / `Buffer.load_int` into a single strided
// load/store with NO runtime bounds check -- they rely entirely on the
// compile-time parameter-constraint verifier
// (`index >= 0 && index < self.length`). These tests lock in the
// verifier fixes found by fuzzing the generated code under AddressSanitizer.
//
// See also: `MEMORY.md` "Compile-time bounds checking".

describe("off-by-one: while i <= length guards an at/set access", () => {
	// `arr.at(i)` inside `while i <= arr.length` lets i reach
	// `arr.length` (an out-of-bounds index; valid indices are
	// 0..length-1). The verifier must NOT treat the inclusive
	// `i <= arr.length` bound as satisfying the strict
	// `i < arr.length` constraint.
	test("read past the last element is rejected", () => {
		const input = `
var arr = Array(10, 20, 30)
var int i = 0
while i <= arr.length {
    Console.write("\\{arr.at(i)} ")
    i = i + 1
}
Console.write("\\nDONE")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("constraint"))).toBe(true);
	});

	test("write past the last element (memory corruption) is rejected", () => {
		const input = `
var arr = Array(10, 20, 30)
var int i = 0
while i <= arr.length {
    arr.set(i, 99)
    i = i + 1
}
Console.write("\\nDONE")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("constraint"))).toBe(true);
	});
});

describe("strict-plus-one upper bound is provably out of bounds", () => {
	// `for i of 0 .. arr.length + 1` makes the loop's upper bound
	// numerically exceed the container length, so the `i < arr.length`
	// constraint is provably unsatisfiable and the access is rejected.
	test("for i of 0 .. arr.length + 1 is rejected", () => {
		const input = `
var arr = Array(10, 20, 30)
for i of 0 .. arr.length + 1 {
    Console.write("\\{arr.at(i)} ")
}
Console.write("\\nDONE")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("constraint"))).toBe(true);
	});
});

describe("guards establish the bound so the access verifies", () => {
	// An explicit `if i < arr.length` (or `if n < arr.length`) gives the
	// verifier the strict `i < arr.length` bound it needs, so the access
	// is accepted. These document the intended escape hatch for runtime
	// (unverifiable) loop bounds -- once unverifiable index constraints
	// are themselves rejected (see known gap below), guarding is how the
	// programmer satisfies the check.
	test("if i < arr.length inside the loop", () => {
		const input = `
var arr = Array(10, 20, 30)
var int n = 10
for i of 0 .. n {
    if i < arr.length {
        Console.write("\\{arr.at(i)} ")
    }
}
Console.write("\\nDONE")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("if n < arr.length once, outside the loop", () => {
		const input = `
var arr = Array(10, 20, 30)
var int n = 10
if n < arr.length {
    for i of 0 .. n {
        Console.write("\\{arr.at(i)} ")
    }
}
Console.write("\\nDONE")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});

// KNOWN REMAINING GAP (not yet caught): a `for i of 0 .. n` loop whose
// upper bound `n` is an unrelated runtime value (not provably <= the
// indexed container's length) is still accepted, and the inlined access
// performs an unchecked read/write. The intended fix is to also reject
// unverifiable index constraints here, requiring the programmer to guard
// the access with `if i < arr.length` (or `if n < arr.length`) as shown
// above. That change currently breaks a large amount of existing code
// (array-literal lengths aren't always tracked for the verifier, and
// Buffer capacity is often unknown-by-design after a runtime grow), so it
// is left as a tracked limitation until that groundwork lands.
//
// This test is intentionally left FAILING so the gap is visible: the
// compiler currently accepts the program (no error), but it should reject
// it until guarded.
describe("known gap: runtime-bounded for loops over an unrelated upper bound", () => {
	test("for i of 0 .. n with n > length should be rejected (requires guard)", () => {
		const input = `
var arr = Array(10, 20, 30)
var int n = 10
for i of 0 .. n {
    Console.write("\\{arr.at(i)} ")
}
Console.write("\\nDONE")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("constraint"))).toBe(true);
	});
});

// Soundness: a `var` reassigned to an out-of-bounds value in one branch of
// an if/else (or switch) must NOT keep its pre-branch bounds in the parent
// scope. Otherwise `if c { i = 100 } arr.at(i)` would wrongly prove
// `i < arr.length` using the stale pre-if range. The fix is to merge bounds
// across branches conservatively (intersect bound exprs, take the loosest
// numeric range; clear when any branch clears).
describe("branch reconciliation does not leak stale bounds", () => {
	test("if/else reassigning i to oob value is rejected", () => {
		const input = `
var arr = Array(10, 20, 30)
var int i = 0
var int cond = 1
if cond == 1 {
	i = 100
} else {
	i = 0
}
Console.write("\\{arr.at(i)}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("constraint"))).toBe(true);
	});

	test("single-if reassigning i to oob value is rejected", () => {
		const input = `
var arr = Array(10, 20, 30)
var int i = 0
var int cond = 1
if cond == 1 {
	i = 100
}
Console.write("\\{arr.at(i)}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("constraint"))).toBe(true);
	});

	test("both branches keep i in range is accepted", () => {
		const input = `
var arr = Array(10, 20, 30)
var int i = 0
var int cond = 1
if cond == 1 {
	i = 1
} else {
	i = 2
}
Console.write("\\{arr.at(i)}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("switch case reassigning i to oob value is rejected", () => {
		const input = `
var arr = Array(10, 20, 30)
var int i = 0
switch {
	case i < 5 {
		i = 100
	}
	else {
		i = 0
	}
}
Console.write("\\{arr.at(i)}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("constraint"))).toBe(true);
	});
});
