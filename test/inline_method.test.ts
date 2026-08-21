import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// General-path (non-raw) method inlining: `List.at` is `pub inline`, so
// `list.at(i)` splices the accessor body into the caller (on top of the
// naked-inlined Buffer load/store primitives). These tests pin the inline
// machinery's state isolation:
//  - the inline return-label rewrite must only touch asm emitted for the
//    inline body (a whole-buffer rewrite used to corrupt the standalone
//    function's own return branches and prefix-mangle sibling labels such
//    as `.return_List_int_at_or` into undefined `.inline_ret_N_or`);
//  - the inlined body's returns are attributed to the inlined method, not
//    the caller (borrow normalization keys on the caller's name used to
//    strdup an inlined borrow inside `at_or`, leaking one copy);
//  - checker-hoisted receiver temps (`_recv_N`) re-emit per inline site.

describe("general-path method inlining", () => {
	test("List.at inlines into callers (accessor chain gone)", () => {
		const parsed = parse_with_imports(`
var List<int> list = List<int>()
list.push(1)
list.push(2)
var int sum = 0
var int j = 0
while j < list.length {
	sum = sum + list.at(j)
	j = j + 1
}
Console.write("\\{sum}\\n")
`);
		expect(parsed.errors).toEqual([]);
		const code = build(parsed.root, { arch: "aarch64", audit: false }).code;
		expect(code).not.toContain("bl List_int_at\n");
		expect(code).toContain("lsl x1, x1, #3\n");
	});

	test("inline label rewrite spares sibling method labels", () => {
		// `at` (inlined) and `at_or` (a plain call) share a name prefix —
		// the mangled rewrite used to turn `b .return_List_int_at_or` into
		// an undefined `b .inline_ret_N_or`.
		const parsed = parse_with_imports(`
var List<int> xs = List<int>()
xs.push(1)
var int j = 0
if j >= 0 && j < xs.length {
	Console.write("\\{xs.at(j)}\\{xs.at_or(5, -1)}\\n")
}
`);
		expect(parsed.errors).toEqual([]);
		const code = build(parsed.root, { arch: "aarch64", audit: false }).code;
		expect(code).not.toMatch(/\.inline_ret_\d+_or\b/);
		expect(code).toContain("b .return_List_int_at_or\n");
	});

	test("multi-site inline with hoisted receiver temps", async () => {
		// Each inline site must emit and clean up its OWN copy of the
		// checker-hoisted `_recv_N` receiver temp (owning struct returned
		// by a call, consumed by a method chain). The audit run catches a
		// missing/leaked per-site copy.
		const input = `
struct Box {
	var List<int> items = List<int>()
}

func make_box = (int seed, out Box) {
	var Box b = Box()
	b.items.push(seed)
	b.items.push(seed + 1)
	return b
}

struct Reader {
	pub inline func first = (self, int seed, out int) {
		return make_box(seed).items.at_or(0, 0)
	}
	pub inline func second = (self, int seed, out int) {
		return make_box(seed).items.at_or(1, 0)
	}
}

var Reader r = Reader()
var int a = r.first(10)
var int b = r.second(20)
var int c = r.first(30)
Console.write("\\{a} \\{b} \\{c}\\n")
`;
		await build_and_check_output(input, "inline_recv_temps", "10 21 30\n");
	});

	test("inlined borrow-returning method doesn't strdup inside at_or", () => {
		// `at_or` returns an owned string (it strdups the fallback), so it
		// is heap-returning. The inlined `at`'s return used to inherit that
		// classification and strdup the borrow as well — one extra strdup
		// per hit (a leak, pinned by the run in accessor_or.test.ts); here
		// the emitted at_or body must contain exactly two strdups (the
		// in-bounds borrow return and the fallback return).
		const parsed = parse_with_imports(`
var List<string> xs = List<string>()
xs.push("real")
Console.write("\\{xs.at_or(0, "fallback")}\\{xs.at_or(5, "fallback")}")
`);
		expect(parsed.errors).toEqual([]);
		const code = build(parsed.root, { arch: "aarch64", audit: false }).code;
		// Slice from the label definition to the LAST occurrence of the
		// return label (branch targets precede the definition).
		const at_or_body = code.slice(
			code.indexOf("List_string_at_or:"),
			code.lastIndexOf(".return_List_string_at_or:"),
		);
		const strdups = at_or_body.match(/bl (_nomen_strdup_wrap|_strdup)/g) ?? [];
		expect(strdups.length).toBe(2);
	});
});
