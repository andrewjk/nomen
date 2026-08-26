import type BuildStatus from "../../build_c/BuildStatus.ts";
import { is_view_value } from "../../build_common/view_value.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type ValueNode from "../../nodes/ValueNode.ts";
import build_node from "../build_node.ts";
import { emit_malloc } from "./audit.ts";

export { is_view_value };

/**
 * Emit the (ptr, len) pair for a `view string` argument into x0/x1.
 * - A view VALUE (a view local/param's two stack slots, or a view-returning
 *   call that leaves the pair in x0/x1) passes through unchanged.
 * - An owned `string` expression is now ITSELF a fat (ptr, len) value —
 *   borrowing it into a view is the identity: build it and keep both halves
 *   in x0/x1. Ownership stays with the caller.
 */
export function emit_view_string_arg(arg: BaseNode, status: BuildStatus) {
	if (is_view_value(arg, status)) {
		if (arg.node_type === "value") {
			const base = status.stack_offsets?.get((arg as ValueNode).value);
			if (base !== undefined) {
				status.code += `ldr x0, [x29, #${base}]\n`;
				status.code += `ldr x1, [x29, #${base + 8}]\n`;
				return;
			}
		}
		build_node(arg, status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		return;
	}
	build_node(arg, status);
	if (!status.code.endsWith("\n")) status.code += "\n";
}

/**
 * Materialize a `view string` into an OWNED heap string. The (ptr, len)
 * pair must be in x0/x1 on entry; on exit x0 holds a malloc'd, null-
 * terminated copy of exactly len bytes (and the caller must reclaim it —
 * set last_result_is_heap / mark the target as a heap string). Mirrors the
 * view `.to_string` builtin sequence.
 */
export function emit_view_materialize_owned(status: BuildStatus) {
	status.code += `stp x0, x1, [sp, #-16]!\n`; // [sp]=ptr, [sp+8]=len
	status.code += `add x0, x1, #1\n`; // len+1
	emit_malloc(status); // x0 = dst
	// Second push: [sp]=dst, [sp+16]=ptr, [sp+24]=len (the first frame's
	// slots sit 16 bytes above the new sp — NOT at [sp+8]/[sp+16]).
	status.code += `str x0, [sp, #-16]!\n`;
	status.code += `ldr x1, [sp, #16]\n`; // ptr
	status.code += `ldr x2, [sp, #24]\n`; // len
	status.code += `ldr x0, [sp]\n`; // dst
	status.code += `bl _memcpy\n`;
	status.code += `ldr x0, [sp]\n`; // dst (don't trust memcpy's return)
	status.code += `ldr x1, [sp, #24]\n`; // len
	status.code += `strb wzr, [x0, x1]\n`; // dst[len] = 0
	status.code += `add sp, sp, #32\n`;
}
