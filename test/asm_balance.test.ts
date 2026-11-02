import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { validate_stack_balance } from "../src/build_aarch64/lift_asm";
import parse_with_imports, { parse_raw } from "./parse_with_imports";

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
	ldp x29, x30, [sp], #16
	ret
1:
	ldp x29, x30, [sp], #16
	ret
`),
	).toEqual([]);
});

test("numeric local label balance: an imbalanced taken path fails loudly", () => {
	// The `1:` path double-pops — resolution of `1f` must FEED the dataflow
	// (an unresolved target would leave the block unreached and silent).
	const messages = balance(`
f:
	stp x29, x30, [sp, #-16]!
	cmp x0, #1
	b.hs 1f
	ldp x29, x30, [sp], #16
	ret
1:
	ldr x19, [sp], #16
	ldp x29, x30, [sp], #16
	ret
`);
	expect(messages.length).toBe(1);
	expect(messages[0]).toContain("unbalanced stack: sp offset 16 at ret");
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

test("a duplicated entry label starts a fresh root, not the stub's delta", () => {
	// The parse_with_imports shape: a user TU whose text opens with the
	// wrapper's no-arg `_main` stub (prologue, no frame, no ret — it falls
	// through) followed by the user's own `_main` with the real frame. The
	// second entry must re-root at delta 0 instead of inheriting the stub's
	// `stp …, [sp, #-16]!` through the fall-through edge (which reported
	// the real entry's ret at `sp offset -16`).
	expect(
		balance(`
.p2align 2
.globl _main
_main:
	stp x29, x30, [sp, #-16]!
	// no stack needed
	mov x29, sp
.p2align 2
.globl _main
_main:
	stp x29, x30, [sp, #-16]!
	sub sp, sp, #16
	mov x29, sp
	mov x0, #42
	str x0, [x29, #0]
.return_1:
	bl _nomen_audit_check
	mov x0, #0
	add sp, sp, #16
	ldp x29, x30, [sp], #16
	ret
.return_0:
	bl _nomen_audit_check
	mov x0, #0
	ldp x29, x30, [sp], #16
	ret
`),
	).toEqual([]);
});

test("the re-rooted real entry is still checked when it is imbalanced", () => {
	// Re-rooting must not blind the check: the stub's delta is gone, but the
	// second entry's own imbalance (a missing pop here) still reports — at
	// ITS offset, not the stub's.
	const messages = balance(`
.p2align 2
.globl _main
_main:
	stp x29, x30, [sp, #-16]!
	mov x29, sp
.p2align 2
.globl _main
_main:
	stp x29, x30, [sp, #-16]!
	ret
`);
	expect(messages.length).toBe(1);
	expect(messages[0]).toContain("unbalanced stack: sp offset -16 at ret");
});

test("a globl'd entry after another function's ret is checked as its own root", () => {
	// Only bl-target / marker-preceded labels cut the lift, so `g` shares
	// f's lifted body — unreachable through f's ret, so without re-rooting
	// its imbalance would sit in the silent null zone forever.
	const messages = balance(`
f:
	stp x29, x30, [sp, #-16]!
	ldp x29, x30, [sp], #16
	ret
.p2align 2
.globl g
g:
	stp x29, x30, [sp, #-16]!
	ret
`);
	expect(messages.length).toBe(1);
	expect(messages[0]).toContain("unbalanced stack: sp offset -16 at ret");
});

test("mid-function non-dot labels (branch joins) keep flowing — no re-root", () => {
	// A plain label under instructions (`end_N:`-style) is a control-flow
	// join, not an entry: the conditional branch's fall-through must still
	// feed it, and its ret stays checkable.
	expect(
		balance(`
f:
	stp x29, x30, [sp, #-16]!
	cbz x0, end_1
	str x19, [sp, #-16]!
	ldr x19, [sp], #16
end_1:
	ldp x29, x30, [sp], #16
	ret
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

test("two mains in a split user TU stay balance-clean", () => {
	// The FOLLOWUP repro: a test program declaring its own `func main`
	// inside the parse_with_imports wrapper (the wrapper's no-arg main plus
	// the user's — two `_main:` labels in one TU), built for aarch64 with
	// audit on in the split user-TU mode build_and_check_output uses. The
	// wrapper stub opens the TU (block 0), so the balance check used to
	// seed it at 0 and hand its `stp …, [sp, #-16]!` delta to the real
	// entry: `asm: unbalanced stack: sp offset -16 at ret — ret`.
	const parsed = parse_with_imports(`
func main = () {
	var x = 42
	Console.write("\\{x}\\n")
}
`);
	const result = build(parsed.root, { arch: "aarch64", audit: true, emit_mode: "user" });
	expect(result.errors ?? []).toEqual([]);
	expect(balance(result.code as string)).toEqual([]);
});
