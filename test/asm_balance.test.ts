import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { validate_stack_balance } from "../src/build_aarch64/lift_asm";
import { parse_raw } from "./parse_with_imports";

/**
 * Stack-balance validation (the deferred ASM_PLAN phase-1 check, now landed
 * as per-block sp dataflow): every function's sp must return to its entry
 * value at each `ret`. Diamond joins with unequal path deltas become UNKNOWN
 * (never error) — the classic epilogue-diamond pattern stays clean while
 * straight-line imbalance fails loudly.
 */

function balance(code: string): string[] {
	return validate_stack_balance(code).map((e) => e.message);
}

function offset_of(messages: string[]): number {
	expect(messages.length).toBeGreaterThan(0);
	const m = /offset (-?\d+)/.exec(messages[0]);
	expect(m).not.toBeNull();
	return Number(m![1]);
}

test("balanced straight-line function is clean", () => {
	expect(
		balance(`
f:
	stp x29, x30, [sp, #-16]!
	str x19, [sp, #-16]!
	sub sp, sp, #32
	add sp, sp, #32
	ldr x19, [sp], #16
	ldp x29, x30, [sp], #16
	ret
`),
	).toEqual([]);
});

test("missing pop is reported with the sp offset at ret", () => {
	const msgs = balance(`
f:
	stp x29, x30, [sp, #-16]!
	str x19, [sp, #-16]!
	ldp x29, x30, [sp], #16
	ret
`);
	expect(offset_of(msgs)).toBe(-16);
});

test("unbalanced early ret is reported", () => {
	const msgs = balance(`
f:
	stp x29, x30, [sp, #-16]!
	cbz x0, .slow
	str x19, [sp, #-16]!
	ret
.slow:
	ldp x29, x30, [sp], #16
	ret
`);
	expect(offset_of(msgs)).toBe(-32);
});

test("diamond with equal path deltas is clean", () => {
	expect(
		balance(`
f:
	stp x29, x30, [sp, #-16]!
	cbz x0, .else
	sub sp, sp, #32
	add sp, sp, #32
	b .epi
.else:
	sub sp, sp, #32
	add sp, sp, #32
.epi:
	ldp x29, x30, [sp], #16
	ret
`),
	).toEqual([]);
});

test("diamond with unequal join deltas becomes unknown, never a false positive", () => {
	// The bool_to_string shape: one path reaches the epilogue with an extra
	// adjustment — the join is unknown and the ret is NOT reported.
	expect(
		balance(`
f:
	stp x29, x30, [sp, #-16]!
	cbz x0, .else
	sub sp, sp, #32
	b .epi
.else:
	sub sp, sp, #32
	add sp, sp, #32
.epi:
	add sp, sp, #32
	ldp x29, x30, [sp], #16
	ret
`),
	).toEqual([]);
});

test("numeric local labels (1: / b.hs 1f) resolve forward and stay clean", () => {
	expect(
		balance(`
f:
	stp x29, x30, [sp, #-16]!
	cmp x0, #1
	b.hs 1f
	ldr x19, [sp], #16
	ldp x29, x30, [sp], #16
	ret
1:
	ldr x19, [sp], #16
	ldp x29, x30, [sp], #16
	ret
`),
	).toEqual([]);
});

test("mov sp, xN poisons the delta and is never reported", () => {
	expect(
		balance(`
f:
	mov sp, x9
	ret
`),
	).toEqual([]);
});

test("bl preserves sp (the callee rebalances under the ABI)", () => {
	expect(
		balance(`
f:
	stp x29, x30, [sp, #-16]!
	bl something
	ldp x29, x30, [sp], #16
	ret
`),
	).toEqual([]);
});

test("br x17 tail-jump ends propagation without a check", () => {
	expect(
		balance(`
f:
	stp x29, x30, [sp, #-16]!
	bl prep
	ldp x29, x30, [sp], #16
	br x17
`),
	).toEqual([]);
});

test("real emitted programs pass the balance check", () => {
	// Integration: a real build's assembly (System library + user code, the
	// same text the phase-1 validator sees) must be balance-clean.
	const parsed = parse_raw(`
import System

func mix = (ref Buffer<float> a, ref Buffer<float> b, int n) {
	if n <= a.cap && n <= b.cap {
		var i = 0
		while i < n; i += 1 {
			b.store_float(i, a.load_float(i) * 2.0 + 1.0)
		}
	}
}
pub func main = () {}
`);
	const result = build(parsed.root, { arch: "aarch64" });
	expect(result.errors ?? []).toEqual([]);
	expect(balance(result.code as string)).toEqual([]);
});
