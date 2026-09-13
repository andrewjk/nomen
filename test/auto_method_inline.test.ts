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
 * sites (282 samples in `BigInt_ensure` per D2 iteration). DEFAULT ON:
 * the JsonTree receipt crash class is refused by the T-generic-callee
 * gate — every crashing splice (`set_kind`, `get_child`, …) nested a
 * `Buffer<T>.load_T`/`store_T` splice, and bodies calling `_T`-suffixed
 * generic methods no longer auto-inline (see FOLLOWUP.md). The tests
 * here pin the ON behavior and the kill switch.
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

test("generic-callee user-inline takes the bl (JsonTree receipt class)", () => {
	// A USER-marked inline method whose body calls a `_T`-generic Buffer
	// method must NOT splice — the nested generic splice miscompiles (the
	// JsonTree receipt: parse of a JSON array lost the node count and
	// child links). Two gates engage: the call site takes the real `bl`,
	// and the standalone body IS emitted (user-inline methods normally
	// skip standalone emission — the bl needs it).
	const src = `
import System

struct Keeper {
	var Buffer<JsonNode> nodes = Buffer<JsonNode>()

	pub func #init = (self) {
		self.nodes.grow_T(4)
	}

	pub inline func reserve = (ref self, int extra) {
		self.nodes.grow_T(extra)
	}
}

pub func main = (Init init) {
	var k = Keeper()
	k.reserve(4)
	Console.write("ok\\n")
}
`;
	const code = compile(src, true);
	expect(code).toContain("bl Keeper_reserve");
	// The standalone body is emitted despite the inline marker.
	expect(code).toMatch(/Keeper_reserve:/);
	// The call site did not splice the load/store pattern.
	expect(code).not.toMatch(/\.LBuffer_JsonNode_buffer_load_T_copy/);
});

test("behavioral: spliced ref-self mutation is exact (both backends)", async () => {
	set_auto_method_inline_enabled(true);
	try {
		await build_and_check_output(ENSURE_SHAPE, "auto_method_inline", "10\n", true);
	} finally {
		set_auto_method_inline_enabled(false);
	}
});
