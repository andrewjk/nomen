import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports, { parse_raw } from "./parse_with_imports";

// Regression tests for the FOLLOWUP.md BUGS entries fixed alongside the
// view-string work: `&&` short-circuiting on aarch64, and declaration-order
// independence of parallel-length contract stripping.

async function build_and_run(input: string, name: string, expected: string, raw = false) {
	for (const arch of ["aarch64", "c"] as const) {
		const parsed = raw ? parse_raw(input) : parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch, audit: true });
		await check_output(name, result, expected, { arch, audit: true });
	}
}

// `y < n && xs.at(y).text == "one"` used to evaluate BOTH operands on
// aarch64 (bitwise AND of two eagerly-computed bools), so the guarded
// `.at(y)` ran on the loop-exit iteration with y == n, read the zeroed slab
// slot past the end, and dereferenced NULL for `.text` — SIGSEGV. The C
// backend short-circuits via C semantics and always printed "count 2".
test("&& short-circuits: guarded .at in a while condition", async () => {
	const input = `
import System

pub class Item {
	var text = ""
}

func build = (out List<Item>) {
	var List<Item> xs = List<Item>()
	var a = Item()
	a.text = "one"
	var b = Item()
	b.text = "one"
	xs.push(mov a)
	xs.push(mov b)
	return xs
}

pub func main = (Init init) {
	const List<Item> xs = build()
	const int n = xs.length
	var y = 0
	var count = 0
	while y < n && xs.at(y).text == "one" {
		count += 1
		y += 1
	}
	Console.write_line("count \\{count}")
}
`;
	await build_and_run(input, "sc_guarded_at_condition", "count 2", true);
});

// `||` must also skip the right operand when the left decides.
test("|| short-circuits", async () => {
	const input = `
var List<int> xs = List<int>()
xs.push(7)
var i = 0
var hits = 0
while i < 3 {
	if i >= xs.length || xs.at(i) == 7 {
		hits += 1
	}
	i += 1
}
Console.write_line("\\{hits}")
`;
	await build_and_run(input, "sc_or_guarded_at", "3");
});

// A parallel-length clause (`hash.length == xs.length`) stripped from the
// callee's signature used to only be removed when the callee's params were
// checked — in file order. A forward reference then asked the CALLER to prove
// a clause no call site could ("Parameter constraint cannot be verified").
// Stripping now happens at signature-gather time.
test("parallel-length contracts are declaration-order independent", () => {
	const input = `
func caller = (List<int> xs, List<int> hash, out int) {
	return probe(xs, hash, 0)
}

func probe = (
	List<int> xs,
	List<int> hash: hash.length == xs.length,
	int hi: hi >= 0 && hi <= xs.length,
	out int,
) {
	var i = 0
	var sum = 0
	while i < hi {
		sum += hash.at(i)
		i += 1
	}
	return sum
}

pub func main = (Init init) {
	Console.write_line("ok")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});
