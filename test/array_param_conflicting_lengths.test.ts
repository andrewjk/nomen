import { expect, test } from "vite-plus/test";

import parse_with_imports from "./parse_with_imports";

// An unsized `T[]` parameter's compile-time length is stamped from the call
// site (the raw array ABI carries no runtime length) and the builds bake it
// into the callee's loops, bounds, and materializations. A second call site
// passing a DIFFERENT compile-time length ran the callee with the stale
// bound — silently truncating (sum_lengths returned 6 for a 3-element array
// whose earlier sibling call stamped 2) or reading past a shorter caller's
// array (the `_platform_memmove` SIGSEGV in the old followup). The checker
// now rejects the conflict; runtime-varying lengths need `Array<T>`.

const FUNC = `
func sum_lengths = (string[] items, out int) {
	var total = 0
	var i = 0
	while i < items.length; i += 1 {
		total += items.at_or_panic(i).length
	}
	return total
}
`;

test("conflicting compile-time lengths are rejected", () => {
	const parsed = parse_with_imports(`
${FUNC}
var string[2] items = ["abc", "de"]
Console.write("a=\\{sum_lengths(items)}\\n")
var string[3] more = ["ab", "cde", "x"]
Console.write("b=\\{sum_lengths(more)}\\n")
`);
	expect(parsed.errors.some((e) => e.message.includes("whose compile-time length is 2"))).toBe(
		true,
	);
});

test("literal conflicting with a stamped variable call is rejected too", () => {
	const parsed = parse_with_imports(`
${FUNC}
var string[2] items = ["abc", "de"]
Console.write("a=\\{sum_lengths(items)}\\n")
Console.write("b=\\{sum_lengths(["zz", "yy", "x"])}\\n")
`);
	expect(parsed.errors.some((e) => e.message.includes("whose compile-time length is 2"))).toBe(
		true,
	);
});

test("consistent lengths across call sites still check clean", () => {
	const parsed = parse_with_imports(`
${FUNC}
var string[2] items = ["abc", "de"]
Console.write("a=\\{sum_lengths(items)}\\n")
Console.write("b=\\{sum_lengths(["zz", "yy"])}\\n")
`);
	expect(parsed.errors).toEqual([]);
});
