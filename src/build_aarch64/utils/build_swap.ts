import type BuildStatus from "../../build_c/BuildStatus.ts";
import type_from_value_node from "../../build_c/utils/type_from_value_node.ts";
import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import { emit_address_of } from "../build_access_node.ts";
import build_node from "../build_node.ts";
import { find_anchor_slot, is_struct_type } from "./auto_destroy.ts";
import { emit_asm, ensure_newline } from "./code_buffer.ts";
import { emit_var_address, emit_var_load } from "./stack_var.ts";
import { get_field_offset, get_type_size } from "./struct_layout.ts";

/**
 * Write-back for `f(mv x swap <repl>)` / `Struct(mv x.field swap <repl>)`
 * call arguments: after the call, the replacement must land in the source
 * slot so the donor is revalidated (a moved-out source must never be
 * destroyed in its moved-out state).
 *
 * The write shape follows the SLOT, not the class-era pointer convention:
 * a heap-instance (class-tier) slot stores the replacement's instance
 * pointer; an inline value-struct slot (a mv struct's field, a struct
 * local) struct-copies the replacement's bytes — storing a pointer into an
 * inline slot leaves the VT word holding a stack address and the value
 * stale (the mov_swap ctor/call-argument failures). Field types resolve
 * through the receiver struct's field list — inside a monomorphized generic
 * method the AccessFieldNode's cached type can still name the generic
 * template, whose size lookup is wrong (the Buffer<T> swap-size
 * regression).
 */
export function build_swap_params(node: FunctionCallNode, status: BuildStatus) {
	if (!node.swap_params?.size) return;

	for (const [idx, swap_expr] of node.swap_params) {
		const source = node.params[idx];
		if (!source) continue;

		build_node(swap_expr, status);
		ensure_newline(status);
		// Park the replacement: an inline value-struct expression leaves its
		// ADDRESS in x0 (the ctor sret temp), a heap instance leaves the
		// instance pointer — the slot's shape below decides which it was.
		emit_asm(status, `str x0, [sp, #-16]!\n`);

		if (
			source.node_type === "access" &&
			(source as AccessNode).access.node_type === "access_field"
		) {
			const src_access = source as AccessNode;
			const src_field = (src_access.access as AccessFieldNode).name;
			const src_target_type = type_from_value_node(src_access.target);
			const target_name =
				src_access.target.node_type === "value" ? (src_access.target as ValueNode).value : "";

			const receiver_struct = src_target_type.name
				? status.structs.find((s) => s.name === src_target_type.name)
				: undefined;
			const field_type =
				receiver_struct?.fields.find((f) => f.name === src_field)?.type ??
				type_from_value_node(src_access.access);
			const field_is_pointer_slot = field_type?.name
				? !!is_struct_type(field_type.name, status)?.is_class
				: false;
			const src_offset = get_field_offset(src_target_type.name, src_field, status);

			if (field_is_pointer_slot) {
				const base_struct = is_struct_type(src_target_type.name, status);
				if (base_struct?.is_class) {
					emit_var_load(status, "x0", target_name, 8);
				} else {
					emit_var_address(status, "x0", target_name);
				}
				ensure_newline(status);
				emit_asm(status, `ldr x1, [sp], #16\n`);
				emit_asm(status, `str x1, [x0, #${src_offset}]\n`);
			} else {
				// Inline value-struct (or scalar/string) field: copy the
				// replacement's bytes over the field slot.
				emit_address_of(src_access.target, status);
				ensure_newline(status);
				emit_asm(status, `ldr x1, [sp], #16\n`);
				const field_size = field_type ? get_type_size(field_type, status) : 8;
				for (let i = 0; i < Math.ceil(field_size / 8); i++) {
					emit_asm(status, `ldr x3, [x1, #${i * 8}]\n`);
					if (src_offset + i * 8 === 0) {
						emit_asm(status, `str x3, [x0]\n`);
					} else {
						emit_asm(status, `str x3, [x0, #${src_offset + i * 8}]\n`);
					}
				}
			}
		} else if (source.node_type === "value") {
			const src_name = (source as ValueNode).value;
			const src_type = type_from_value_node(source);
			const src_is_pointer_slot = !!is_struct_type(src_type.name, status)?.is_class;
			if (src_is_pointer_slot) {
				emit_var_address(status, "x0", src_name);
				ensure_newline(status);
				emit_asm(status, `ldr x1, [sp], #16\n`);
				emit_asm(status, `str x1, [x0]\n`);
				const anchor = find_anchor_slot(status, src_name);
				if (anchor !== undefined) {
					emit_asm(status, `str x1, [x29, #${anchor}]\n`);
				}
			} else {
				// Inline value-struct local: struct-copy the replacement over
				// the local's slot.
				emit_var_address(status, "x0", src_name);
				ensure_newline(status);
				emit_asm(status, `ldr x1, [sp], #16\n`);
				const src_size = get_type_size(src_type, status);
				for (let i = 0; i < Math.ceil(src_size / 8); i++) {
					emit_asm(status, `ldr x3, [x1, #${i * 8}]\n`);
					if (i === 0) {
						emit_asm(status, `str x3, [x0]\n`);
					} else {
						emit_asm(status, `str x3, [x0, #${i * 8}]\n`);
					}
				}
			}
			// The source is revalidated — a moved-out marking must not skip
			// its scope-exit destroy now that it holds a fresh value.
			status.moved?.delete(src_name);
		}
	}
}
