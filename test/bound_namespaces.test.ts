import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";
import build_and_check_output from "./build_and_check_output.ts";

const core = path.resolve(import.meta.dirname, "../core");

// Constraint targets name the CALLEE params, but guard facts are recorded
// under the CALLER's names. A pushed argument defaults its alias to the
// argument's own path, so differently-named slice bounds verify.
test("differently named slice bounds verify and run", async () => {
	const input = `
pub func snip = (string text, int lo, int hi, out string) {
	if lo >= 0 && lo <= text.length && hi >= lo && hi <= text.length {
		view v = text.slice(lo, hi)
		return v.to_string()
	}
	return ""
}

var string doc = "hello world"
var int lo = 0
var int hi = 5
Console.write(snip(doc, lo, hi))
Console.write(snip(doc, 6, 11))
`;
	await build_and_check_output(input, "bound_namespace_slice", "helloworld");
});

// An inclusive upper bound chains like the strict path: `start <= middle`
// plus `middle <= text.length` discharges `start <= self.length`.
test("inclusive upper bounds chain transitively", async () => {
	const input = `
pub func f = (string text, int start, int middle, out string) {
	if start >= 0 && start <= middle && middle <= text.length && text.length >= start {
		view v = text.slice(start, text.length)
		return v.to_string()
	}
	return ""
}

var string doc = "hello world"
Console.write(f(doc, 0, 5))
`;
	await build_and_check_output(input, "bound_inclusive_transitive", "hello world");
});

describe("bound namespace soundness", () => {
	test("a var literally named length does not prove non-negativity", () => {
		const input = `
import System
func need_nonneg = (string t, int start: start >= 0, out string) {
	return t
}
pub func take = (string t, int length, out string) {
	return need_nonneg(t, length)
}
pub func main = (Init init) {
	Console.write(take("hello", 5))
}
`;
		const parsed = parse(input, get_library(core));
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("cannot be verified"))).toBe(true);
	});
});
