/**
 * Branch-free comparison-assign lowering (ASM_PLAN_3 tranche B).
 *
 * `var x = 0; if <pure scalar comparison> { x = 1 }` is a materialized
 * boolean. Fused at the NIR declare dispatch, it lowers to
 * `cmp/cset` straight into the variable's home — no branch, no join
 * label, no block boundary. Block boundaries are what force live
 * expression temps to their frame slots (the phase-2 boundary rule), so
 * in hot straight-line kernels (BigInt's Knuth-D carry computation:
 * `p_mc = 0; if p_mid < p_lh { p_mc = 1 }`) removing the branch also
 * removes the slot round-trips around it and lets the register
 * machinery hold the neighboring products.
 *
 * Soundness: the fused pair replaces a declare and an if whose only
 * effect is the 0→1 flag write; the condition operands are gated to
 * plain scalar value nodes (no calls, no ref args, no side effects).
 * Compound conditions (`&&`/`||`), float comparisons, and anything the
 * direct-branch path would not recognize keep their branches.
 *
 * Kill-switch for the byte-identity A/B harness: with the flag off, the
 * declare and the if emit exactly as before.
 */

let cset_lowering_on = true;

export function cset_lowering_enabled(): boolean {
	return cset_lowering_on;
}

export function set_cset_lowering_enabled(enabled: boolean): void {
	cset_lowering_on = enabled;
}
