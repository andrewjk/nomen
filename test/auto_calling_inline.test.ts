import { expect, test } from "vite-plus/test";

import build from "../src/build";
import {
	auto_calling_inline_enabled,
	auto_method_inline_enabled,
	set_auto_calling_inline_enabled,
	set_auto_method_inline_enabled,
} from "../src/build_aarch64/utils/scan_inline_candidates";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

/**
 * Call-bearing auto inlining (the ASM_PLAN_7 follow-up). An auto
 * candidate whose body CALLS admits when every call splices through
 * (the callee is itself admitted at the next depth, or user-`inline`)
 * or is an `extern` — the ensure→grow_int chain: the hot path's `bl`
 * disappears entirely (grow's `cap >= needed` fast path inlines into
 * the caller), and only cold-path extern bls remain. The original
 * +52–62% regression for this shape was the leaked `nir_site_allocs`
 * clear in build_inline_method stripping the host function's loop
 * planning, not an intrinsic splice cost. The tests here pin the ON
 * shape, both kill switches, the refusals, the depth cap, and the
 * splice-hygiene property the leak fix restored.
 */

const STORE_SHAPE = `
import System

struct Store {
	var int cap = 0

	func grow_to = (ref self, int needed, out int: out >= needed) {
		if self.cap >= needed {
			return self.cap
		}
		var int new_cap = self.cap
		if new_cap == 0 {
			new_cap = 4
		}
		while new_cap < needed; new_cap *= 2 { }
		self.cap = new_cap
		return self.cap
	}

	func ensure = (ref self, int needed) {
		self.grow_to(needed)
	}
}

pub func main = (Init init) {
	var s = Store()
	var int i = 0
	while i < 5; i += 1 {
		s.ensure(i * 3)
	}
	Console.write("cap=\\{s.cap}\\n")
}
`;

function compile(source: string, opts: { auto: boolean; calling: boolean }): string {
	const saved_auto = auto_method_inline_enabled();
	const saved_calling = auto_calling_inline_enabled();
	set_auto_method_inline_enabled(opts.auto);
	set_auto_calling_inline_enabled(opts.calling);
	try {
		const parsed = parse_raw(source);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		return result.code;
	} finally {
		set_auto_method_inline_enabled(saved_auto);
		set_auto_calling_inline_enabled(saved_calling);
	}
}

function loop_body(code: string): string {
	const start = code.indexOf(".while_0:");
	const end = code.indexOf(".end_while_0:");
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return code.slice(start, end);
}

test("ON: the ensure→grow chain splices with no bl at the hot site", () => {
	const on = compile(STORE_SHAPE, { auto: true, calling: true });
	expect(on).not.toContain("bl Store_ensure");
	// grow_to is still called — once, from ensure's STANDALONE body (the
	// hot site spliced through to grow_to's expansion directly).
	expect(on.split("bl Store_grow_to").length - 1).toBe(1);
	// The standalone bodies are still emitted (trait dispatch, method
	// values, and overflow-arg call sites keep taking the bl).
	expect(on).toMatch(/Store_ensure:/);
	expect(on).toMatch(/Store_grow_to:/);
});

test("the call kill switch restores the leaf-only dispatch (off arm)", () => {
	const off = compile(STORE_SHAPE, { auto: true, calling: false });
	expect(off).toContain("bl Store_ensure");
	// The hot site takes the bl; ensure's standalone body still forwards.
	expect(off.split("bl Store_grow_to").length - 1).toBe(1);
	expect(off).toMatch(/Store_grow_to:/);
});

test("the auto kill switch still disables everything", () => {
	const off = compile(STORE_SHAPE, { auto: false, calling: true });
	expect(off).toContain("bl Store_ensure");
});

test("the defaults are ON", () => {
	expect(auto_method_inline_enabled()).toBe(true);
	expect(auto_calling_inline_enabled()).toBe(true);
});

test("a call to a non-spliceable method keeps the host on the bl path", () => {
	// int.to_string() is neither an extern nor a spliceable method
	// (scalar receiver — the at_or receipt class), so the candidate
	// refuses and the call site keeps the real call.
	const src = `
import System

struct Tag {
	var int n = 0

	func render = (ref self) {
		Console.write_line(self.n.to_string())
	}
}

pub func main = (Init init) {
	var t = Tag()
	t.n = 7
	t.render()
}
`;
	const on = compile(src, { auto: true, calling: true });
	expect(on).toContain("bl Tag_render");
});

test("the depth cap refuses a chain that outlives it", () => {
	// A(1 stmt) → B(1) → C(1) → D(15-stmt leaf): C's callee D refuses at
	// depth 3, so C refuses at depth 2, B at depth 1, A at depth 0 —
	// every link stays a real call.
	const src = `
import System

struct Chain {
	var int v = 0

	func d = (ref self) {
		self.v = self.v + 1
		self.v = self.v + 2
		self.v = self.v + 3
		self.v = self.v + 4
		self.v = self.v + 5
		self.v = self.v + 6
		self.v = self.v + 7
		self.v = self.v + 8
		self.v = self.v + 9
		self.v = self.v + 10
		self.v = self.v + 11
		self.v = self.v + 12
		self.v = self.v + 13
		self.v = self.v + 14
		self.v = self.v + 15
	}

	func c = (ref self) {
		self.d()
	}

	func b = (ref self) {
		self.c()
	}

	func a = (ref self) {
		self.b()
	}
}

pub func main = (Init init) {
	var ch = Chain()
	ch.a()
	Console.write("\\{ch.v}\\n")
}
`;
	const on = compile(src, { auto: true, calling: true });
	expect(on).toContain("bl Chain_a");
});

test("behavioral: the expanded chain keeps capacity semantics on both backends", async () => {
	const src = `
import System

struct Box {
	var int cap = 0

	func grow_to = (ref self, int needed, out int: out >= needed) {
		if self.cap >= needed {
			return self.cap
		}
		var int new_cap = self.cap
		if new_cap == 0 {
			new_cap = 4
		}
		while new_cap < needed; new_cap *= 2 { }
		self.cap = new_cap
		return self.cap
	}

	func ensure = (ref self, int needed) {
		self.grow_to(needed)
	}

	func ensure_report = (ref self, int needed, out int) {
		self.grow_to(needed)
		return self.cap
	}
}

pub func main = (Init init) {
	var b = Box()
	b.ensure(4)
	Console.write_line("cap after 4: \\{b.cap}")
	b.ensure(8)
	Console.write_line("cap after 8: \\{b.cap}")
	b.ensure(16)
	Console.write_line("cap after 16: \\{b.cap}")
	b.ensure(100)
	Console.write_line("cap after 100: \\{b.cap}")
	b.ensure(3)
	Console.write_line("cap after 3: \\{b.cap}")
	var int i = 0
	while i < 20; i += 1 {
		b.ensure(i * 1000 + 1)
	}
	Console.write_line("cap after ramp: \\{b.cap}")
	var int j = 0
	while j < 4; j += 1 {
		// The mark_dirty receipt shape: a DECLARATION whose initializer is
		// a splicing call, inside a loop. The call site's dest hint (the
		// declaration's planned register) must not leak into the spliced
		// body — a leaked hint made the body's interior ops write the
		// caller's callee-saved register and skipped the result writeback.
		var int c = b.ensure_report(j * 100 + 1)
		Console.write_line("cap at \\{j}: \\{c}")
	}
}
`;
	const expected = [
		"cap after 4: 4",
		"cap after 8: 8",
		"cap after 16: 16",
		"cap after 100: 128",
		"cap after 3: 128",
		"cap after ramp: 32768",
		"cap at 0: 32768",
		"cap at 1: 32768",
		"cap at 2: 32768",
		"cap at 3: 32768",
		"",
	].join("\n");
	await build_and_check_output(src, "auto_calling_caps", expected, true);
});

test("splice hygiene: a spliced call ahead of a loop leaves the loop untouched", () => {
	// The leak receipt: build_inline_method cleared nir_site_allocs and
	// never restored it, so every statement AFTER a spliced call in the
	// same function emitted slot-resident (the host function's whole
	// register plan silently stripped). The pin: the SAME loop body must
	// emit identically whether or not a spliced call precedes it.
	const loop_only = `
import System

pub func main = (Init init) {
	var int acc = 0
	var int i = 0
	while i < 10; i += 1 {
		acc = acc + i
	}
	Console.write("\\{acc}\\n")
}
`;
	const splice_first = `
import System

struct Holder {
	var int v = 0

	pub inline func bump = (self, int x, out int) {
		return self.v + x
	}
}

pub func main = (Init init) {
	var h = Holder()
	var int t = h.bump(1)
	var int acc = 0
	var int i = 0
	while i < 10; i += 1 {
		acc = acc + i
	}
	Console.write("\\{acc} \\{t}\\n")
}
`;
	const bare = loop_body(compile(loop_only, { auto: true, calling: true }));
	const spliced = loop_body(compile(splice_first, { auto: true, calling: true }));
	expect(spliced).toBe(bare);
});
