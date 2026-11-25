import { describe, expect, test } from "vite-plus/test";

import parse from "../src/parse";

// The branch-value policy (docs/CODE_REVIEW.md §1.4, "full symmetry"):
// `->` introduces a ONE-LINE branch value, `let` yields a BLOCK branch's
// value, and `=>` is the LAMBDA introducer ONLY. The old parsers
// substituted `=>` for `return` in branch/statement positions — an
// undocumented return-from-branch form — and substituted `->` for `let` in
// block branches. Both substitutions are errors with a named fix.

const FAT_ARROW = "'=>' introduces a lambda";

describe("arrow introducers", () => {
	test("`=>` in an if branch names the fix", () => {
		const input = `
var x = 1
const r = if x > 0 => "yes"
          else => "no"
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBe(2);
		expect(parsed.errors.every((e) => e.message.includes(FAT_ARROW))).toBe(true);
	});

	test("`=>` in a match arm names the fix", () => {
		const input = `
var x = 1
const r = match x {
	case 1 => "one"
	case _ => "other"
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBe(2);
		expect(parsed.errors.every((e) => e.message.includes(FAT_ARROW))).toBe(true);
	});

	test("`=>` in a switch arm names the fix", () => {
		const input = `
var x = 1
const r = switch {
	case x > 0 => "pos"
	case _ => "neg"
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBe(2);
		expect(parsed.errors.every((e) => e.message.includes(FAT_ARROW))).toBe(true);
	});

	test("`=>` in a #switch arm names the fix", () => {
		const input = `
#switch {
	case META.arch == "c" => 1
	case META.arch == "aarch64" => 2
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBe(2);
		expect(parsed.errors.every((e) => e.message.includes(FAT_ARROW))).toBe(true);
	});

	test("`=>` as a statement names the return fix", () => {
		const input = `
func f = (out int) {
	=> 5
}
`;
		const parsed = parse(input);
		expect(parsed.errors.map((e) => e.message)).toContain(
			`'=>' introduces a lambda — use 'return' to return a value`,
		);
	});

	test("`return => expr` names the fix", () => {
		const input = `
func f = (out int) {
	return => 5
}
`;
		const parsed = parse(input);
		expect(parsed.errors.map((e) => e.message)).toContain(
			`'=>' introduces a lambda — write 'return expr'`,
		);
	});

	test("`->` in a block branch names the let fix", () => {
		const input = `
var x = 1
const r = if x > 0 {
	-> "yes"
} else {
	-> "no"
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBe(2);
		expect(parsed.errors.every((e) => e.message.includes("'->' doesn't yield a block"))).toBe(true);
	});

	test("lambda `=>` and one-line branch `->` still parse clean", () => {
		const input = `
var func (int, out int) doubler = (x) => x * 2
var x = 1
const a = if x > 0 -> "yes" else -> "no"
const b = match x {
	case 1 -> "one"
	case _ -> "other"
}
`;
		expect(parse(input).errors).toEqual([]);
	});
});
