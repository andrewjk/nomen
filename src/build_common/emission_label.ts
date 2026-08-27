import type FunctionNode from "../nodes/FunctionNode.ts";

/**
 * The backend emission label for a function: the checker-assigned
 * `label_name` for a function declared nested inside another function body
 * (uniquified across the program — siblings sharing a source name, or
 * monomorphized clones of one generic parent, must not collide), or the
 * source name (sanitized of `#` markers) for top-level functions.
 *
 * Every site that emits or references a function SYMBOL — definitions, `bl`
 * targets, heap/borrow-returning classification, stack-arg placeholders —
 * must go through this so nested labels stay consistent.
 */
export default function emission_label(
	func: FunctionNode | { name: string; label_name?: string },
): string {
	return (func.label_name ?? func.name).replace(/#/g, "");
}
