/**
 * Flag-form carry lowering (ASM_PLAN_3 tranche J).
 *
 * The pidigits profile (Knuth-D multiply-subtract loops) computes every
 * carry/borrow the same way:
 *
 * ```
 * const prod = a + b        // or a - b
 * [plain assign]            // e.g. mul_carry = hi_prod
 * var c = 0
 * if prod < a { c = 1 }     // — or —  if prod < a { x += 1 }
 * ```
 *
 * The comparison `prod < a` is EXACTLY the carry-out of `a + b`: the
 * `adds`/`subs` forms set the NZCV flags as a side effect of computing
 * prod, so the whole compare (cmp + its two operand stagings) collapses
 * into the declare's own arithmetic and the flag materializes with one
 * `cset` — or, when the consumer is `x += 1` on a register home, one
 * `cinc` (clang's `adds; cinc` idiom).
 *
 * Mechanism: the fuse (try_emit_carry_fold in emit_nir.ts) matches the
 * statement window and emits the declare DIRECTLY — operands staged into
 * x1/x2, one adds/subs straight into prod's promoted home. No one-shot
 * emitter state: the declare builder may (and does) build an initializer
 * more than once, so the flag form must not ride a consumed-once arm.
 *
 * Soundness: flags survive `mov`/`ldr`/`str` (the only instructions the
 * gated window can emit between the adds and the cset/cinc), the fold is
 * unsigned-only (`<` over an add and `>` over a sub are the carry/borrow
 * flag; signed overflow is not), and comparisons with no flag
 * equivalent (`==`, `!=`, `<` after `-`, `>` after `+`) decline.
 *
 * Kill-switch for the byte-identity A/B harness: with the flag off, the
 * fuse declines — byte-identical output.
 */

let flag_form_on = true;

export function flag_form_enabled(): boolean {
	return flag_form_on;
}

export function set_flag_form_enabled(enabled: boolean): void {
	flag_form_on = enabled;
}
