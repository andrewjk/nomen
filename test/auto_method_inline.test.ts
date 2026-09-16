import { expect, test } from "vite-plus/test";

import build from "../src/build";
import {
	auto_method_inline_enabled,
	set_auto_method_inline_enabled,
} from "../src/build_aarch64/utils/scan_inline_candidates";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

/**
 * Auto method inlining (ASM_PLAN_7 tranche 7). Small unmarked methods
 * (the BigInt `ensure`/`clear` shape) splice through the proven
 * user-inline path, killing the per-call `bl` + ABI marshal at hot call
 * sites (282 samples in `BigInt_ensure` per D2 iteration). DEFAULT ON.
 * User-marked `inline` methods also splice when their bodies nest a
 * `Buffer<T>.load`/`store` splice: the old JsonTree crash class was
 * the inline body's local declarations clobbering the caller's
 * `stack_offsets` name→slot entries (now isolated per splice). The
 * tests here pin the ON behavior, the nested-generic splice, and the
 * kill switch.
 */

const ENSURE_SHAPE = `
import System

struct Acc {
	var int total

	pub func #init = (self) {
		self.total = 0
	}

	func add_to = (ref self, int v) {
		self.total = self.total + v
	}
}

pub func main = (Init init) {
	var a = Acc()
	var int i = 0
	while i < 4; i += 1 {
		a.add_to(i + 1)
	}
	Console.write("\\{a.total}\\n")
}
`;

function compile(source: string, on: boolean): string {
	const saved = auto_method_inline_enabled();
	set_auto_method_inline_enabled(on);
	try {
		const parsed = parse_raw(source);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		return result.code;
	} finally {
		set_auto_method_inline_enabled(saved);
	}
}

test("ON: a small ref-self method splices instead of calling", () => {
	const on = compile(ENSURE_SHAPE, true);
	expect(on).not.toContain("bl Acc_add_to");
	// The standalone body is still emitted (trait dispatch, method
	// values, and overflow-arg call sites keep taking the bl).
	expect(on).toMatch(/Acc_add_to:/);
});

test("the kill switch restores the call (off arm)", () => {
	const off = compile(ENSURE_SHAPE, false);
	expect(off).toContain("bl Acc_add_to");
	expect(off).not.toBe(compile(ENSURE_SHAPE, true));
});

test("the default is ON", () => {
	expect(auto_method_inline_enabled()).toBe(true);
});

test("ON: a recursive small method still compiles (nested call takes the bl)", () => {
	const src = `
import System

struct Down {
	var int n

	pub func #init = (self) {
		self.n = 0
	}

	func walk = (ref self, int k) {
		if k > 0 {
			self.walk(k - 1)
		}
		self.n = k
	}
}

pub func main = (Init init) {
	var d = Down()
	d.walk(3)
	Console.write("\\{d.n}\\n")
}
`;
	const on = compile(src, true);
	// The outer call spliced; the nested recursive call fell back to bl.
	expect(on).toContain("bl Down_walk");
});

test("generic-callee user-inline splices (JsonTree receipt class)", () => {
	// A USER-marked inline method whose body calls a generic Buffer
	// method splices: the nested generic splice is sound now that the
	// inline body's locals own a fresh name→slot map (the JsonTree crash
	// was the caller's `n` being remapped onto the body's `var Node n`).
	// The call site splices and no standalone body is emitted.
	const src = `
import System

struct Keeper {
	var Buffer<JsonNode> nodes = Buffer<JsonNode>()

	pub func #init = (self) {
		self.nodes.grow(4)
	}

	pub inline func reserve = (ref self, int extra) {
		self.nodes.grow(extra)
	}
}

pub func main = (Init init) {
	var k = Keeper()
	k.reserve(4)
	Console.write("ok\\n")
}
`;
	const code = compile(src, true);
	expect(code).not.toContain("bl Keeper_reserve");
	// No standalone body for a spliced inline method.
	expect(code).not.toMatch(/Keeper_reserve:/);
});

test("behavioral: splice isolates caller locals from body locals", async () => {
	// Regression for the JsonTree receipt: a spliced method's stack-resident
	// local (`var Inner n` — the JsonNode shape) used to overwrite the
	// caller's same-named name→slot entry, so the caller read the body's
	// slot after the splice, yielding 21 instead of 2 + 21.
	const src = `
import System

struct Inner {
	var int v = 0
}

struct Counter {
	var int base = 1

	pub func #init = (self) {
		self.base = 1
	}

	pub inline func inner_add = (self, int x, out int) {
		var Inner n = Inner()
		n.v = x * 10
		return n.v + 1
	}

	pub inline func outer = (self, int seed, out int) {
		var int n = seed
		var int r = self.inner_add(seed)
		return n + r
	}
}

pub func main = (Init init) {
	var c = Counter()
	Console.write("\\{c.outer(2)}\\n")
}
`;
	await build_and_check_output(src, "inline_name_collision", "23\n", true);
});

test("behavioral: spliced ref-self mutation is exact (both backends)", async () => {
	set_auto_method_inline_enabled(true);
	try {
		await build_and_check_output(ENSURE_SHAPE, "auto_method_inline", "10\n", true);
	} finally {
		set_auto_method_inline_enabled(false);
	}
});
