import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

const PRELUDE = `
trait Rule {
	func test = (self, string line, out bool)
}
struct HeadingV : Rule {
	pub func test = (self, string line, out bool) {
		return line.at_or(0, ' ') == '#'
	}
}
struct QuoteV : Rule {
	pub func test = (self, string line, out bool) {
		return line.at_or(0, ' ') == '>'
	}
}
class HeadingC : Rule {
	pub func test = (self, string line, out bool) {
		return line.at_or(0, ' ') == '#'
	}
}
`;

function expect_error(source: string, fragment: string) {
	const parsed = parse_with_imports(source);
	expect(parsed.errors.some((e) => e.message.includes(fragment))).toBe(true);
}

describe("two-tier value-struct trait conformers — accepted (tier 1)", () => {
	test("trait local initialized from a value-struct conformer runs", async () => {
		const input =
			PRELUDE +
			`
func test = () {
	var Rule r = HeadingV()
	if r.test("# h") {
		Console.write_line("heading")
	} else {
		Console.write_line("other")
	}
}
test()
`;
		await build_and_check_output(input, "two_tier_local_init", "heading");
	});

	test("same-conformer reassignment stays legal", async () => {
		const input =
			PRELUDE +
			`
func test = () {
	var Rule r = HeadingV()
	r = HeadingV()
	if r.test("# h") {
		Console.write_line("heading")
	}
}
test()
`;
		await build_and_check_output(input, "two_tier_same_conformer", "heading");
	});

	test("value-struct trait slot copies and re-binds the same conformer", async () => {
		const input =
			PRELUDE +
			`
func test = () {
	var Rule r = HeadingV()
	var Rule r2 = r
	r2 = HeadingV()
	if r2.test("# h") {
		Console.write_line("heading")
	}
}
test()
`;
		await build_and_check_output(input, "two_tier_value_copy", "heading");
	});

	test("conformer propagates through a trait-typed copy for rejection", () => {
		// r2 inherits r's bound conformer, so storing a different conformer
		// through r2 must be rejected exactly like through r.
		expect_error(
			PRELUDE +
				`
func test = () {
	var Rule r = HeadingV()
	var Rule r2 = r
	r2 = QuoteV()
}
test()
`,
			"bound to 'HeadingV'",
		);
	});

	test("class conformer into a trait-typed array is untouched", () => {
		// Check-level assertion only: acceptance is the contract here (the
		// trait-array element cleanup has a pre-existing, unrelated leak, so
		// this shape isn't run through the audited runtime harness).
		const input =
			PRELUDE +
			`
func test = () {
	var Array<Rule> rules = [HeadingC()]
	if rules.at(0).test("# h") {
		Console.write_line("heading")
	}
}
test()
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});

describe("two-tier value-struct trait conformers — rejected (tier 2)", () => {
	test("cross-conformer reassignment is rejected", () => {
		expect_error(
			PRELUDE +
				`
func test = () {
	var Rule r = HeadingV()
	r = QuoteV()
}
test()
`,
			"bound to 'HeadingV'",
		);
	});

	test("cross-conformer reassignment to a struct with fields is rejected", () => {
		expect_error(
			PRELUDE +
				`
struct BigV : Rule {
	var int a
	var int b
	var int c
	pub func test = (self, string line, out bool) {
		return false
	}
}
func test = () {
	var Rule r = HeadingV()
	r = BigV(1, 2, 3)
}
test()
`,
			"bound to 'HeadingV'",
		);
	});

	test("reassignment from an unknown-conformer value is rejected", () => {
		expect_error(
			PRELUDE +
				`
func pick = (out Rule) {
	return HeadingC()
}
func test = () {
	var Rule r = HeadingV()
	r = pick()
}
test()
`,
			"bound to 'HeadingV'",
		);
	});

	test("a class instance cannot be stored into a value-struct trait slot", () => {
		expect_error(
			PRELUDE +
				`
func test = () {
	var Rule r = HeadingV()
	r = HeadingC()
}
test()
`,
			"bound to 'HeadingV'",
		);
	});

	test("value-struct conformer into a trait-typed array literal is rejected", () => {
		expect_error(
			PRELUDE +
				`
func test = () {
	var Array<Rule> rules = [HeadingV()]
}
test()
`,
			"value struct 'HeadingV' cannot be used as trait 'Rule'",
		);
	});

	test("value-struct-backed trait local cannot cross a call boundary", () => {
		expect_error(
			PRELUDE +
				`
func try_rule = (Rule rule, string line, out bool) => rule.test(line)
func test = () {
	var Rule r = HeadingV()
	const bool b = try_rule(r, "# h")
}
test()
`,
			"cannot cross a call boundary",
		);
	});

	test("value-struct conformer still rejected as a direct trait argument", () => {
		expect_error(
			PRELUDE +
				`
func try_rule = (Rule rule, string line, out bool) => rule.test(line)
func test = () {
	const bool b = try_rule(HeadingV(), "# h")
}
test()
`,
			"value struct 'HeadingV' cannot be used as trait 'Rule'",
		);
	});

	test("class-backed trait slot copy is rejected", () => {
		expect_error(
			PRELUDE +
				`
func test = () {
	var Rule a = HeadingC()
	var Rule b = a
}
test()
`,
			"class-backed trait local cannot be copied",
		);
	});

	test("storing a value struct into a class-backed trait slot is rejected", () => {
		expect_error(
			PRELUDE +
				`
func test = () {
	var Rule b = HeadingC()
	b = HeadingV()
}
test()
`,
			"value struct 'HeadingV' cannot be used as trait 'Rule'",
		);
	});
});
