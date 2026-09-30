import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// A heap `Array<T>` parameter carries its own runtime length (the `Array_<T>`
// header field), so one parameter must accept varying-length array literals
// across call sites. The checker's compile-time length stamp — needed only
// for RAW `T[]` params (the raw ABI carries no runtime length) and its
// "conflicting array param lengths" rejection — previously fired for
// `Array<T>` params too, pinning them to the first call site's literal
// length (the error text itself recommends `Array<T>` for this shape).
// Heap-array params are no longer stamped; raw `T[]` params keep the stamp
// and the conflict check (see array_param_conflicting_lengths.test.ts).

const FUNC = `
func total_len = (Array<string> items, out int) {
	var total = 0
	for w of items {
		total += w.length
	}
	return total
}
`;

test("varying-length literals across call sites check clean", () => {
	const parsed = parse_with_imports(`
${FUNC}
pub func main = (Init init) {
	var a = total_len(["http", "https"])
	Console.write("a=\\{a}\\n")
	var b = total_len(["http", "https", "irc", "ircs", "mailto", "xmpp"])
	Console.write("b=\\{b}\\n")
}
`);
	expect(parsed.errors).toEqual([]);
});

test("raw T[] conflicting lengths are still rejected", () => {
	const parsed = parse_with_imports(`
func sum_lengths = (string[] items, out int) {
	var total = 0
	var i = 0
	while i < items.length; i += 1 {
		total += items.at_or_panic(i).length
	}
	return total
}
pub func main = (Init init) {
	Console.write("a=\\{sum_lengths(["ab", "cd"])}\\n")
	Console.write("b=\\{sum_lengths(["ab", "cd", "ef"])}\\n")
}
`);
	expect(parsed.errors.some((e) => e.message.includes("whose compile-time length is 2"))).toBe(
		true,
	);
});

test("Array<string> param runs with varying-length literals", async () => {
	const input = `
import System

${FUNC}

pub func main = (Init init) {
	var a = total_len(["http", "https"])
	Console.write("a=\\{a}\\n")
	var b = total_len(["http", "https", "irc", "ircs", "mailto", "xmpp"])
	Console.write("b=\\{b}\\n")
}
`;
	await build_and_check_output(input, "array_param_varying_lengths", "a=9\nb=26\n", true);
});

test("Array<int> param runs with varying-length literals", async () => {
	const input = `
import System

func total = (Array<int> values, out int) {
	var total = 0
	for v of values {
		total += v
	}
	return total
}

pub func main = (Init init) {
	var a = total([1, 2])
	Console.write("a=\\{a}\\n")
	var b = total([1, 2, 3, 4])
	Console.write("b=\\{b}\\n")
}
`;
	await build_and_check_output(input, "array_param_varying_lengths_int", "a=3\nb=10\n", true);
});
