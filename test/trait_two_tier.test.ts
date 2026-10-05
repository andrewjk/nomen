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

describe("boxed trait conformers — accepted (STRUCT_PLAN_3 B4)", () => {
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

	test("cross-conformer reassignment re-boxes", async () => {
		const input =
			PRELUDE +
			`
func test = () {
	var Rule r = HeadingV()
	if r.test("# h") {
		Console.write_line("heading")
	}
	r = QuoteV()
	if r.test("> q") {
		Console.write_line("quote")
	}
}
test()
`;
		await build_and_check_output(input, "b4_cross_conformer", "heading\nquote");
	});

	test("reassignment from an unknown-conformer value stores the handle", async () => {
		const input =
			PRELUDE +
			`
func pick = (out Rule) {
	return HeadingC()
}
func test = () {
	var Rule r = HeadingV()
	r = pick()
	if r.test("# h") {
		Console.write_line("heading")
	}
}
test()
`;
		await build_and_check_output(input, "b4_unknown_conformer", "heading");
	});

	test("a class instance stores into a formerly value-struct slot", async () => {
		const input =
			PRELUDE +
			`
func test = () {
	var Rule r = HeadingV()
	r = HeadingC()
	if r.test("# h") {
		Console.write_line("heading")
	}
}
test()
`;
		await build_and_check_output(input, "b4_class_into_box_slot", "heading");
	});

	test("a value-struct conformer crosses a call boundary as a bare parameter", async () => {
		const input =
			PRELUDE +
			`
func try_rule = (Rule rule, string line, out bool) => rule.test(line)
func test = () {
	var Rule r = HeadingV()
	const bool b = try_rule(r, "# h")
	if b {
		Console.write_line("heading")
	}
	const bool c = try_rule(HeadingV(), "# h")
	if c {
		Console.write_line("direct")
	}
}
test()
`;
		await build_and_check_output(input, "b4_bare_param", "heading\ndirect");
	});

	test("a moved value-struct local boxes into a trait-typed List", async () => {
		const input =
			PRELUDE +
			`
func test = () {
	var List<Rule> rules = List<Rule>()
	var HeadingV h = HeadingV()
	rules.push(move h)
	rules.push(QuoteV())
	var int i = 0
	while i < rules.length {
		if rules.at(i).test("# h") {
			Console.write_line("heading")
		}
		if rules.at(i).test("> q") {
			Console.write_line("quote")
		}
		i = i + 1
	}
}
test()
`;
		await build_and_check_output(input, "b4_list_push", "heading\nquote");
	});

	test("a moved value-struct local boxes into a `move Trait` parameter", async () => {
		const input =
			PRELUDE +
			`
func take = (move Rule rule) {
	if rule.test("# h") {
		Console.write_line("heading")
	}
}
func test = () {
	var HeadingV h = HeadingV()
	take(move h)
}
test()
`;
		await build_and_check_output(input, "b4_move_param", "heading");
	});

	test("a value-struct conformer returned from a trait-typed function boxes", async () => {
		const input =
			PRELUDE +
			`
func pick = (out Rule) {
	return HeadingV()
}
func test = () {
	var Rule r = pick()
	if r.test("# h") {
		Console.write_line("heading")
	}
}
test()
`;
		await build_and_check_output(input, "b4_trait_return", "heading");
	});
});

describe("boxed trait conformers — ownership rules (B4/T2)", () => {
	test("boxing a bare local is an implicit move — the donor is invalid after", () => {
		expect_error(
			PRELUDE +
				`
func test = () {
	var HeadingV h = HeadingV()
	var Rule r = h
	if h.test("# h") {
		Console.write_line("heading")
	}
}
test()
`,
			"used after move",
		);
	});

	test("boxing a field read is rejected — the box would share its owned state", () => {
		expect_error(
			PRELUDE +
				`
struct Holder {
	var HeadingV rule
}
func test = () {
	var Holder h = Holder(HeadingV())
	var Rule r = h.rule
}
test()
`,
			"boxing owns its instance",
		);
	});

	test("a trait handle cannot be copied — spell the move", () => {
		expect_error(
			PRELUDE +
				`
func test = () {
	var Rule a = HeadingV()
	var Rule b = a
}
test()
`,
			"cannot copy a trait handle",
		);
	});

	test("a moved handle is invalid in the donor afterwards", () => {
		expect_error(
			PRELUDE +
				`
func test = () {
	var Rule a = HeadingV()
	var Rule b = move a
	if a.test("# h") {
		Console.write_line("heading")
	}
}
test()
`,
			"used after move",
		);
	});

	test("a value-struct field cannot box into a `move Trait` parameter", () => {
		expect_error(
			PRELUDE +
				`
struct Holder {
	var HeadingV rule
}
func take = (move Rule rule) { }
func test = () {
	var Holder h = Holder(HeadingV())
	take(move h.rule)
}
test()
`,
			"boxing owns its instance",
		);
	});
});
