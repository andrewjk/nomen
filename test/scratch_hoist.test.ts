import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { scratch_hoist_enabled, set_scratch_hoist_enabled } from "../src/build_aarch64/region_pool";
import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

/**
 * Scratch-pool receiver hoists (ASM_PLAN_7 tranche 3).
 *
 * A nested loop's planned pool pin can be unwritable at emission time —
 * most often an ENCLOSING bracket's pin holds the register, a state the
 * plan cannot see. When the plan's scratch scan proved the loop's
 * emission never touches x4–x8 (no real call, no unsafe statement shape,
 * every inline accessor confined to x0–x3), the bracket draws the
 * receiver's data-pointer hoist from NIR_SCRATCH_X instead. The
 * spectral-norm receipt: eval_a_times_u's j-loop re-derived `u.data`
 * (`mov x9, x20; ldr x9, [x9, #8]`) every iteration because the i-loop's
 * bracket held its planned register; after the fallback the derivation
 * rides the preheader and the body indexes `[x7, j, lsl #3]` directly.
 */

const NESTED_SHAPE = `
import System

func eval_like<T> = (ref Buffer<T> au, ref Buffer<T> u, int n) {
	if n <= au.cap && n <= u.cap {
		var i = 0
		while i < n; i += 1 {
			var uint64 a = 0
			var j = 0
			while j < n; j += 1 {
				a = a + (u.load_int(j) as uint64)
				au.store_int(i, a as int)
			}
		}
	}
}

pub func main = (Init init) {
	var u = Buffer<uint64>()
	var v = Buffer<uint64>()
	u.alloc_int(4)
	v.alloc_int(4)
	var int k = 0
	while k < 4; k += 1 {
		u.store_int(k, k + 1)
	}
	eval_like(ref v, ref u, 4)
	Console.write("\\{v.load_int(0)}\\n")
}
`;

function compile(source: string, hoist_on: boolean): string {
	const saved = scratch_hoist_enabled();
	set_scratch_hoist_enabled(hoist_on);
	try {
		const parsed = parse_raw(source);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(result.errors ?? []).toEqual([]);
		return result.code;
	} finally {
		set_scratch_hoist_enabled(saved);
	}
}

/** Slice the LAST while loop: its header, body, update block, and tail. */
function hot_loop(code: string): { pre: string; body: string; update: string; post: string } {
	const starts: { index: number; n: string }[] = [];
	for (const m of code.matchAll(/\.while_(\d+):/g)) {
		starts.push({ index: m.index!, n: m[1] });
	}
	expect(starts.length).toBeGreaterThan(0);
	const { index: start, n } = starts[starts.length - 1];
	const end_label = `.end_while_${n}:`;
	const end = code.indexOf(end_label, start);
	expect(end).toBeGreaterThan(start);
	const update_label = `.while_update_${n}:`;
	const update_start = code.indexOf(update_label, start);
	// Loops without an update clause (`while c { ... }` with the step in
	// the body) emit no update label — the whole body is the step.
	const update = update_start > start ? code.slice(update_start, end) : code.slice(start, end);
	return {
		pre: code.slice(Math.max(0, start - 1200), start),
		body: code.slice(start, end),
		update,
		post: code.slice(end, end + 400),
	};
}

test("pool-refused inner-loop receivers hoist into scratch registers", () => {
	const code = compile(NESTED_SHAPE, true);
	const loop = hot_loop(code);
	// The bracket entry derives both receivers' data pointers into
	// scratch registers before the header.
	expect(loop.pre).toMatch(/mov x[4-8], x9\n/);
	// The body indexes straight off the scratch registers — no
	// per-iteration derivation (`ldr x9, [x9, #8]`) survives.
	expect(loop.body).toMatch(/ldr x0, \[x[4-8], x\d+, lsl #3\]/);
	expect(loop.body).toMatch(/str x\d+, \[x[4-8], x\d+, lsl #3\]/);
	expect(loop.body).not.toContain("ldr x9, [x9, #8]");
});

test("kill-switch restores the per-iteration derivation", () => {
	const on = compile(NESTED_SHAPE, true);
	const off = compile(NESTED_SHAPE, false);
	const loop_on = hot_loop(on);
	const loop_off = hot_loop(off);
	// With the fallback off, the inner loop re-derives the receiver's
	// data pointer every iteration (the pre-tranche behavior).
	expect(loop_off.body).toContain("ldr x9, [x9, #8]");
	expect(loop_off.body).not.toMatch(/ldr x0, \[x[4-8], x\d+, lsl #3\]/);
	// And the fallback actually fired when on.
	expect(loop_on.body).not.toContain("ldr x9, [x9, #8]");
	expect(on).not.toBe(off);
});

test("a real call in the inner loop refuses the fallback", () => {
	const with_call = NESTED_SHAPE.replace(
		"au.store_int(i, a as int)",
		'au.store_int(i, a as int)\n\t\t\t\tConsole.write("")',
	);
	const code = compile(with_call, true);
	const loop = hot_loop(code);
	// A real call clobbers the scratch set (args ride x0–x7), so the
	// plan refuses the loop outright: the derivation stays in the body.
	expect(loop.body).toContain("ldr x9, [x9, #8]");
	expect(loop.body).not.toMatch(/ldr x0, \[x[4-8], x\d+, lsl #3\]/);
});

test("behavioral: scratch-hoisted nested receivers (both backends)", async () => {
	await build_and_check_output(NESTED_SHAPE, "scratch_hoist_nested", "10\n", true);
});
