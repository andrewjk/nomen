import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import IndexNode from "../nodes/IndexNode.ts";
import type Type from "../nodes/Type.ts";
import build_node from "./build_node.ts";
import { emit_asm, ensure_newline } from "./utils/code_buffer.ts";
import {
	emit_index_address,
	emit_index_load,
	pointer_element_size,
	scaled_load_instr,
} from "./utils/ptr_access.ts";

/**
 * `p[index]` (rvalue) on the aarch64 backend: build the pointer (x0) and
 * the index (x1), scale by the element width, and load with the
 * width-matched instruction sequence the raw `load_T` blocks hand-wrote.
 * Strings load as the (ptr, len) register pair; sub-word scalars
 * zero/sign-extend; structs byte-copy into the x8 sret buffer.
 *
 * Fast path: when the target is a plain identifier, the pointer load is a
 * `mov`/`ldr` (never a call), so index → x1 then target → x0 can feed a
 * single scaled `ldr x0, [x0, x1, lsl #k]` — the same shape the raw
 * blocks these replace emitted, with no stack traffic.
 */
export default function build_index_node(node: IndexNode, status: BuildStatus) {
	const elem = node.type ?? elem_from_target(node, status);
	const size = pointer_element_size(elem, status);

	if (node.target.node_type === "value" && node.index.node_type === "value") {
		const fused = scaled_load_instr(elem.name, size);
		if (fused) {
			build_node(node.index, status);
			ensure_newline(status);
			emit_asm(status, `mov x1, x0\n`);
			build_node(node.target, status);
			ensure_newline(status);
			emit_asm(status, `${fused}\n`);
			return;
		}
	}

	build_node(node.target, status);
	ensure_newline(status);
	emit_asm(status, `str x0, [sp, #-16]!\n`);
	build_node(node.index, status);
	ensure_newline(status);
	emit_asm(status, `mov x1, x0\n`);
	emit_asm(status, `ldr x0, [sp], #16\n`);
	emit_index_address(size, status);
	emit_index_load(elem, status);
}

function elem_from_target(node: IndexNode, _status: BuildStatus): Type {
	return type_from_value_node(node.target);
}
