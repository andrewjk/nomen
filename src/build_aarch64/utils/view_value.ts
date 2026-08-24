import type BuildStatus from "../../build_c/BuildStatus.ts";
import type_from_value_node from "../../build_c/utils/type_from_value_node.ts";
import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import build_node from "../build_node.ts";
import { emit_malloc } from "./audit.ts";

/**
 * Resolve the struct name of an expression's value by walking the access
 * chain through the (monomorphized) struct table — bare names via
 * variable_types / scoped declarations / `self`, field accesses via the
 * base struct's field type, method calls via the method's return type.
 * Fallback for cached node types that lost their modifiers (generic bodies
 * re-checked after monomorphization can carry a stale plain `string`).
 */
function value_struct_name(node: BaseNode, status: BuildStatus): string | undefined {
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		if (name === "self" && status.current_struct) return status.current_struct.name;
		const vt = status.variable_types?.get(name);
		if (vt?.name) return vt.name;
		const decl = status.scoped_declarations.findLast((d) => d.name === name);
		if (decl?.type?.name) return decl.type.name;
		return undefined;
	}
	if (node.node_type === "access") {
		const inner = (node as AccessNode).access;
		const base = value_struct_name((node as AccessNode).target, status);
		if (!base) return undefined;
		const struct = status.structs.find((s) => s.name === base && !s.is_generic);
		if (!struct) return undefined;
		if (inner.node_type === "access_field") {
			const field = struct.fields.find((f) => f.name === (inner as AccessFieldNode).name);
			return field?.type?.name;
		}
		if (inner.node_type === "access_func") {
			const func = struct.functions.find((f) => f.name === (inner as AccessFunctionCallNode).name);
			return func?.return_type?.name;
		}
	}
	return undefined;
}

/**
 * Whether an expression is a `view T` VALUE — a (ptr, len) pair that can be
 * passed to a `view T` parameter unchanged (loaded from the value's two
 * stack slots, or produced directly by a view-returning call). Recovers
 * `is_view` from the cached node type, the declared variable type, the
 * current function's view params, or (for method calls whose cached type
 * lost the modifier) the callee's declared return type.
 */
export function is_view_value(node: BaseNode, status: BuildStatus): boolean {
	if (type_from_value_node(node)?.is_view) return true;
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		if (status.variable_types?.get(name)?.is_view) return true;
		if (status.function_view_params?.has(name)) return true;
	}
	if (node.node_type === "access" && (node as AccessNode).access.node_type === "access_func") {
		const access = (node as AccessNode).access as AccessFunctionCallNode;
		const recv_struct = value_struct_name((node as AccessNode).target, status);
		const struct = status.structs.find((s) => s.name === recv_struct && !s.is_generic);
		const func = struct?.functions.find(
			(f) => f.name === access.name || f.name === `#${access.name}`,
		);
		if (func?.return_type?.is_view) return true;
	}
	return false;
}

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
