/**
 * Fixed-array element-address pipeline (ASM_PLAN_3 tranche A).
 *
 * `.at(i).field` on a fixed-size array of structs re-derives the whole
 * element address per access (base slot load + stride constant + index
 * shift + add — ~7 instructions) and pushes the result through x0. This
 * pass pins `base + i*stride` in a callee-saved register per (array,
 * index) pair so consecutive accesses become single `ldr [p, #off]`
 * loads, with float fields loading straight into d0 (no x0 crossing).
 *
 * Soundness: a fixed array IS storage (local slot or ref-param pointer to
 * caller storage), so its element-base address cannot change while the
 * index is unchanged. The cache is invalidated when the index or the
 * array name is assigned, on any non-inlined call (conservative — a ref
 * arg may write the index), and at loop/function/inline boundaries (the
 * same bracketing the Buffer data-pointer cache uses). The pinned
 * registers are callee-saved, claimed in callee_saved_regs_used, so
 * calls and loop promotions never clobber them.
 *
 * Kill-switch for the byte-identity A/B harness: with the flag off, no
 * cache entry is ever created and every access emits the historical
 * sequence byte-for-byte.
 */

let array_licm_on = true;

export function array_licm_enabled(): boolean {
	return array_licm_on;
}

export function set_array_licm_enabled(enabled: boolean): void {
	array_licm_on = enabled;
}
