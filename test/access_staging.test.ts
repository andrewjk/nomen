import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { set_access_staging_enabled } from "../src/build_aarch64/access_staging";
import { parse_raw } from "./parse_with_imports";

/**
 * Access staging bypass (ASM_PLAN_3 tranche L): the per-statement x0 staging
 * model for inline Buffer accessor index sums. The checker hoists every
 * non-value call argument into a `_param_N` const, so each computed index
 * (the pidigits `wd_off + j + si2` shape; here `i + 1`) materialized through
 * a frame slot and was re-derived at every access; the receiver's data
 * pointer re-derived per access too. The tranche forwards qualifying
 * hoisted temps to the access site, builds pure `+` chains dest-directed,
 * and pins the index sum + data pointer in x10/x11 across a verified
 * straight-line window (plain declares/assigns and fused cset/carry-fold
 * spans only; textual fences kill pins at any label, branch, call, or
 * pin-register write).
 */

function compile(source: string): string {
	const parsed = parse_raw(source);
	expect(parsed.errors).toEqual([]);
	// Release build: the NIR planning (promotions/site allocs) the staging
	// window composes with is optimize-gated, matching bench builds.
	const result = build(parsed.root, { arch: "aarch64", optimize: true });
	expect(result.errors ?? []).toEqual([]);
	return result.code;
}

function first_loop_body(code: string, fn: string): string {
	const in_fn = code.slice(code.indexOf(`\n${fn}:`), code.indexOf("\n_main:"));
	const start = in_fn.indexOf("\n.while_");
	// The loop-END label (line-anchored): the back-branch targets it by
	// name, so a plain indexOf would cut the slice inside `b.ge .end_…`.
	const end = in_fn.indexOf("\n.end_while_", start);
	expect(start).toBeGreaterThan(0);
	return in_fn.slice(start, end);
}

const LOAD_LOAD_STORE = `
import System

func f = (ref Buffer<int> buf, out int) {
	var int total = 0
	var int i = 0
	while i + 1 < buf.cap {
		const int a = buf.load_int(i)
		const int b = buf.load_int(i + 1)
		total = total + a + b
		buf.store_int(i, total)
		i += 1
	}
	return total
}

pub func main = () {
	var Buffer<int> buf = Buffer<int>()
	buf.grow_int(4)
	buf.store_int(0, 1)
	buf.store_int(1, 2)
	buf.store_int(2, 3)
	buf.store_int(3, 4)
	Console.write("\\{f(ref buf)}")
}
`;

test("repeated accesses reuse an index pin and one data pointer derivation", () => {
	const code = compile(LOAD_LOAD_STORE);
	const body = first_loop_body(code, "f");
	// A pin register (x10/x11) becomes a strided index register: the
	// load_int(i) sum is built once into the pin and the store reads it
	// without re-derivation.
	expect(body).toMatch(/(?:ldr x0|str x2), \[x\d+, x1[01], lsl #3\]\n/);
	// Exactly ONE data-pointer derivation in the window (the fill); the
	// second access reads the pinned/cached register.
	expect((body.match(/ldr x\d+, \[x\d+, #8\]\n/g) ?? []).length).toBe(1);
	// No hoisted `_param_N` index round-trips a frame slot inside the body.
	expect(body).not.toMatch(/str x\d+, \[x29, #\d+\]\n.*ldr x\d+, \[x29, #\d+\]\n/);
});

test("kill-switch restores the hoisted-temp slot staging", () => {
	set_access_staging_enabled(false);
	try {
		const off = compile(LOAD_LOAD_STORE);
		const body = first_loop_body(off, "f");
		// The pre-tranche shape: no pin registers as strided indexes...
		expect(body).not.toMatch(/, x1[01], lsl #3\]/);
		// ...and the i+1 index stages through its hoisted temp's slot.
		expect(body).toMatch(/str x\d+, \[x29, #\d+\]\n/);
	} finally {
		set_access_staging_enabled(true);
	}
});

test("a call statement between the accesses re-derives the index", () => {
	const code = compile(`
import System

func bump = (int x, out int) {
	return x + 1
}

func f = (ref Buffer<int> buf, out int) {
	var int total = 0
	var int i = 0
	while i + 1 < buf.cap {
		const int a = buf.load_int(i)
		total = bump(a)
		buf.store_int(i, total)
		i += 1
	}
	return total
}

pub func main = () {
	var Buffer<int> buf = Buffer<int>()
	buf.grow_int(4)
	buf.store_int(0, 1)
	buf.store_int(1, 2)
	buf.store_int(2, 3)
	buf.store_int(3, 4)
	Console.write("\\{f(ref buf)}")
}
`);
	const body = first_loop_body(code, "f");
	// The call taints the window (its inline expansion ends in a label
	// besides): the store's strided index register must have been (re)built
	// AFTER the call — the load's pin did not survive across it.
	const lines = body.split("\n");
	const store_line = lines.findIndex((l) => /^str x2, \[x\d+, x\d+, lsl #3\]$/.test(l));
	expect(store_line).toBeGreaterThan(0);
	const idx_reg = lines[store_line].match(/\[x\d+, (x\d+), lsl #3\]/)![1];
	let label_line = -1;
	for (let li = store_line - 1; li >= 0; li--) {
		if (lines[li].endsWith(":")) {
			label_line = li;
			break;
		}
	}
	expect(label_line).toBeGreaterThan(0);
	const rebuilt = lines
		.slice(label_line + 1, store_line)
		.some((l) => new RegExp(`^(?:mov|ldr|add) ${idx_reg},`).test(l));
	expect(rebuilt).toBe(true);
});

test("behavioral: staged loops produce exact results on both backends", async () => {
	const { default: build_and_check_output } = await import("./build_and_check_output");
	// load(i) + load(i+1) with the store back through the same pin:
	// 1+2=3 -> store(0,3); 3+2+3=8 -> store(1,8); 8+3+4=15 -> store(2,15).
	await build_and_check_output(LOAD_LOAD_STORE, "access_staging_basic", "15", true);
	// Term-write invalidation: the store must see the NEW i (buf=[1,1,2,4]).
	await build_and_check_output(
		`
import System

func bump = (int x, out int) {
	return x + 1
}

func f = (ref Buffer<int> buf, out int) {
	var int total = 0
	var int i = 0
	while i + 1 < buf.cap {
		const int a = buf.load_int(i)
		total = bump(a)
		buf.store_int(i, total)
		i += 1
	}
	return total
}

pub func main = () {
	var Buffer<int> buf = Buffer<int>()
	buf.grow_int(4)
	buf.store_int(0, 1)
	buf.store_int(1, 2)
	buf.store_int(2, 3)
	buf.store_int(3, 4)
	Console.write("\\{f(ref buf)}")
}
`,
		"access_staging_taint",
		"4",
		true,
	);
});
