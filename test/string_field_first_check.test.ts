import { describe, expect, test } from "vite-plus/test";

import parse_program from "./parse_with_imports";

/**
 * Regression: the FIRST check of a module whose structs carry direct `string`
 * fields used to report hidden `start: -1` errors — the auto-derived `copy`
 * body's shell-constructor call (`var c = Person(self.name)`) tripped the
 * "cannot copy field X into parameter Y by value" rule, and the offset-less
 * error made parse report `ok: false` with an EMPTY user-facing error list
 * (format_errors filters start < 0) while suppressing the warning pass. The
 * shell ctor is now stamped (`synthesized_copy_ctor`) and exempt: it seeds a
 * FRESH instance, so there is no displaced value to double-free (string ctor
 * params strdup; container/struct params alias only until the per-field
 * stores of the copy body overwrite them).
 */
describe("first check with direct string fields", () => {
	test("mv struct with a string field checks clean and lints", () => {
		const parsed = parse_program(`
mv struct Person {
	pub var string name
}

pub func main = () {
	var p = Person("alice")
	var q = p.copy()
	Console.write_line(q.name)
}
`);
		expect(parsed.errors).toEqual([]);
		expect(parsed.ok).toBe(true);
		// The warning pass must run on the first check — it used to be
		// suppressed by the hidden error.
		expect(parsed.warnings.length).toBeGreaterThan(0);
	});

	test("string + defaulted fields check clean", () => {
		const parsed = parse_program(`
mv struct Item {
	var string label
	var string tag = "none"
	var int weight
}

pub func main = () {
	var i = Item("bolt", 5)
	var j = i.copy()
	Console.write_line(j.label)
}
`);
		expect(parsed.errors).toEqual([]);
		expect(parsed.ok).toBe(true);
	});

	test("a genuine field-copy into an mv parameter is still rejected", () => {
		const parsed = parse_program(`
mv struct Group {
	var List<int> items
}

pub func main = () {
	var a = Group(List<int>())
	var b = Group(a.items)
}
`);
		const err = parsed.errors.find((e) =>
			e.message.includes("cannot copy field 'items' into parameter 'items' by value"),
		);
		expect(err).toBeDefined();
		expect(parsed.ok).toBe(false);
	});
});
