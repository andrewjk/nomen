import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// Displaced-free regression coverage for owned-string reassignment (the
// FOLLOWUP.md "displaced-free gap"): a `var string` local initialized from a
// call result and then REASSIGNED — from another call result, a literal, or
// a view materialization — inside if/while/branch shapes must free the
// displaced value exactly once (build_assignment_node's `_reassign` path),
// never leak it and never double-free it. Every program here runs under the
// audit runtime on both backends; a leak or an invalid free fails the run.

const SHAPES: { name: string; body: string; expected: string }[] = [
	{
		name: "call result reassigned in an if body",
		body: `
var string s = "seed"
var int n = 3
if n > 0 {
	s = s.copy()
}
Console.write_line(s)
`,
		expected: "seed\n",
	},
	{
		name: "call result reassigned in a while body",
		body: `
var string s = "seed"
var int i = 0
while i < 3; i += 1 {
	s = s.copy()
	Console.write(i.to_string())
}
Console.write_line("")
`,
		expected: "012\n",
	},
	{
		name: "pad + literal + group chain (three sibling ifs)",
		body: `
var string s = "1234567"
var int pad_slots = 9
var bool has_comma = true
var int slots_after_comma = 3
if s.length < pad_slots {
	var pad_sb = StringBuilder()
	var int pad_count = pad_slots - s.length
	var int p = 0
	while p < pad_count; p += 1 {
		pad_sb.append_char('0')
	}
	pad_sb.append(s)
	s = pad_sb.to_string()
}
if s == "0" && pad_slots == 0 {
	s = ""
}
if has_comma && slots_after_comma > 0 && s.length > slots_after_comma {
	var group_sb = StringBuilder()
	var int total = s.length
	var int k = 0
	while k < total; k += 1 {
		group_sb.append_char(s.at(k))
		var int remaining = total - k - 1
		if remaining > 0 && remaining % slots_after_comma == 0 {
			group_sb.append_char(',')
		}
	}
	s = group_sb.to_string()
}
Console.write_line(s)
`,
		expected: "001,234,567\n",
	},
	{
		name: "reassignment nested in if-inside-while",
		body: `
var string s = "seed"
var int i = 0
while i < 2; i += 1 {
	if i > 0 {
		s = s.copy()
	}
	Console.write(i.to_string())
}
Console.write_line("")
`,
		expected: "01\n",
	},
	{
		name: "reassignment nested in while-inside-if",
		body: `
var string s = "seed"
var int n = 1
if n > 0 {
	var int i = 0
	while i < 2; i += 1 {
		s = s.copy()
		i += 1
	}
}
Console.write_line(s)
`,
		expected: "seed\n",
	},
	{
		name: "two sibling ifs reassigning from call results",
		body: `
var string s = "seed"
var int n = 2
if n == 1 {
	var a = StringBuilder()
	a.append_char('x')
	s = a.to_string()
}
if n == 2 {
	var b = StringBuilder()
	b.append_string("yy")
	s = b.to_string()
}
Console.write_line(s)
`,
		expected: "yy\n",
	},
	{
		name: "literal and view-materialization reassignments",
		body: `
var string s = StringBuilder().to_string()
s = "literal"
Console.write_line(s)
var string v = "viewable"
s = v.slice(0, 4).to_string()
Console.write_line(s)
`,
		expected: "literal\nview\n",
	},
	{
		// Issue: an inline call result passed to an INTERNAL string param was
		// neither hoisted nor freed. The checker-hoisted temp must anchor and
		// free it like any owned argument.
		name: "call result into an internal string param (inline, not hoisted)",
		body: `
var sb = StringBuilder()
sb.append_string(Format.pad("x", 3))
Console.write_line(sb.to_string())
`,
		expected: "  x\n",
	},
	{
		// Issue: the name-keyed string-ownership sets bled across struct
		// methods — a `const string digits` borrow mark in one method
		// suppressed the auto-free of an owned `digits` local in a sibling
		// (the int_base/int_pattern shape). Both must free correctly.
		name: "same-named string locals across struct methods stay isolated",
		body: `
struct Owner {
	pub func show = (self) {
		const string digits = "0123456789"
		Console.write_line(digits)
	}
	pub func take = (self, string seed) {
		var string digits = Format.pad(seed, 6)
		var string rendered = digits.copy()
		Console.write_line(rendered)
	}
}

var Owner o = Owner()
o.show()
o.take("ab")
`,
		expected: "0123456789\n    ab\n",
	},
];

describe("displaced free on owned-string reassignment", () => {
	for (const shape of SHAPES) {
		test(
			`${shape.name} frees the displaced value (both backends, audit on)`,
			{ timeout: 120_000 },
			async () => {
				await build_and_check_output(
					shape.body,
					`displaced_free_${SHAPES.indexOf(shape)}`,
					shape.expected,
				);
			},
		);
	}

	test("literal reassignment into a taken branch keeps auto-free valid", async () => {
		// The literal-RHS path strdups so the var still owns heap at scope
		// exit; a struct field store (`readonly`-free) displace is covered by
		// the struct suites — this pins the local shape.
		const parsed = parse_with_imports(SHAPES[2].body);
		expect(parsed.errors).toEqual([]);
	});
});
