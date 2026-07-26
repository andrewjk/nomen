// AAPCS64 stack-argument passing for functions whose argument count exceeds
// the 8 register slots (x0..x7). The first 8 slots arrive in registers; every
// further slot arrives in the caller's outgoing stack area.
//
// After a callee runs the prologue:
//   stp x29, x30, [sp, #-16]!
//   <N pushes via `str xN, [sp, #-16]!`>
//   sub sp, sp, #STACK_SIZE
//   mov x29, sp
// the caller's first stack arg (slot 8) lives at:
//   [x29, #(16 + 16*N + STACK_SIZE)]
// and slot (8+k) at:
//   [x29, #(16 + 16*N + STACK_SIZE + k*8)]
//
// STACK_SIZE is not known while the prologue is emitting (locals are allocated
// as the prologue runs), so callers emit a text placeholder for the offset and
// patch it once the final frame size is known.

export const REG_ARG_REGS = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];
export const NUM_REG_ARGS = 8;

// Byte offset from a callee's x29 to its k-th incoming stack arg (slot 8+k),
// given `callee_saved_pushes` callee-saved register pushes in the prologue and
// a `total_stack`-byte local frame.
export function stack_arg_offset(
	callee_saved_pushes: number,
	total_stack: number,
	k: number,
): number {
	return 16 + 16 * callee_saved_pushes + total_stack + k * 8;
}

// Patch every `OVERFLOW_BASE_<label>_<k>` text placeholder in `code` with the
// concrete byte offset of the k-th incoming stack arg from the callee's x29.
export function patch_overflow_placeholders(
	code: string,
	label: string,
	callee_saved_pushes: number,
	total_stack: number,
): string {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`OVERFLOW_BASE_${escaped}_(\\d+)`, "g");
	return code.replace(re, (_match, k) =>
		String(stack_arg_offset(callee_saved_pushes, total_stack, parseInt(k, 10))),
	);
}

// Build a placeholder reference for stack arg `k` of function `label`. The
// placeholder is patched by `patch_overflow_placeholders` once STACK_SIZE is
// known.
export function overflow_placeholder(label: string, k: number): string {
	return `OVERFLOW_BASE_${label}_${k}`;
}
