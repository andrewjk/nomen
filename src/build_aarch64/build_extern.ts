import type BuildStatus from "../build_c/BuildStatus.ts";
import emission_label from "../build_common/emission_label.ts";
import { is_overloaded, mangled_label } from "../check/utils/function_overload.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import { emit_asm } from "./utils/code_buffer.ts";

/**
 * Emit an `extern func` for the aarch64 backend: a fixed-shape adapter that
 * forwards the Nomen call ABI to the C symbol.
 *
 * Free externs keep the parse-assigned `extern_<name>` label; method
 * externs take the normal `Struct_method` label (passed via `struct_node`)
 * — emitting the adapter under the bare C name would interpose the libc
 * symbol it wraps. The wrapped symbol itself is always the bare Nomen name.
 *
 * Incoming (Nomen ABI): scalars and floats take one register slot each
 * (floats arrive as raw bits — `fmov d0, xN`); a fat `string` takes a
 * (ptr, len) REGISTER PAIR. Outgoing (C ABI): scalars one x-register,
 * floats one d-register, strings only the thin ptr.
 *
 * Because strings consume two incoming slots but one outgoing slot, every
 * parameter's outgoing index is <= its incoming index; moving in REVERSE
 * parameter order can therefore never clobber an unread incoming value.
 *
 * Float params are only supported as the SOLE parameter for now (the
 * sqrt/log shape): float32/64 argument lists would need s/d register
 * assignment per AAPCS64.
 */
export default function build_extern(
	node: FunctionNode,
	status: BuildStatus,
	struct_node?: StructNode,
) {
	const method_label = struct_node
		? is_overloaded(struct_node, node.name)
			? mangled_label(node, struct_node.name)
			: `${struct_node.name}_${node.name.replace(/#/g, "")}`
		: undefined;
	const label = method_label ?? emission_label(node);
	const prefix = status.platform === "windows" ? "" : "_";
	// Under audit, allocator externs must route through the audit runtime's
	// wrappers so the balanced alloc/free counter sees the calls (mirrors the
	// C backend's wrap_c_allocators).
	const raw_symbol = `${prefix}${node.name.replace(/#/g, "")}`;
	const audit_wrapped =
		status.audit && status.platform !== "windows"
			? {
					free: "_nomen_free_wrap",
					malloc: "_nomen_malloc_wrap",
					calloc: "_nomen_calloc_wrap",
					realloc: "_nomen_realloc_wrap",
					strdup: "_nomen_strdup_wrap",
				}[node.name]
			: undefined;
	const symbol = audit_wrapped ?? raw_symbol;

	const float_params = node.params.filter(
		(p) => !p.is_variadic && (p.type.name.startsWith("float") || p.type.name.startsWith("ufloat")),
	);
	const use_float = float_params.length === 1 && node.params.length === 1;

	emit_asm(status, `.p2align 2\n`);
	emit_asm(status, `.globl ${label}\n`);
	emit_asm(status, `${label}:\n`);
	if (status.platform !== "windows") {
		emit_asm(status, `.globl _${label}\n`);
		emit_asm(status, `_${label} = ${label}\n`);
	}
	emit_asm(status, `stp x29, x30, [sp, #-16]!\n`);
	emit_asm(status, `mov x29, sp\n`);

	if (use_float) {
		// (float x) -> symbol(d0); bits arrive in x0.
		emit_asm(status, `fmov d0, x0\n`);
		emit_asm(status, `bl ${symbol}\n`);
		if (node.return_type.name) {
			emit_asm(status, `fmov x0, d0\n`);
		}
	} else {
		// Compute each param's (incoming slot, outgoing slot) pair.
		const moves: { out: number; in: number }[] = [];
		let in_slot = 0;
		let out_slot = 0;
		for (const param of node.params) {
			const is_string = param.type.name === "string";
			moves.push({ out: out_slot, in: in_slot });
			if (is_string) {
				in_slot += 2;
			} else {
				in_slot += 1;
			}
			out_slot += 1;
		}
		for (let i = moves.length - 1; i >= 0; i--) {
			const { out, in: inc } = moves[i];
			if (out !== inc) {
				emit_asm(status, `mov x${out}, x${inc}\n`);
			}
		}
		emit_asm(status, `bl ${symbol}\n`);

		if (node.return_type.name === "string") {
			// Wrap the returned char* into the fat (ptr, len) pair: x0 = ptr.
			// strlen clobbers x0 and x30, so spill the pointer and the
			// adapter-internal return address first.
			emit_asm(status, `stp x0, x30, [sp, #-16]!\n`);
			emit_asm(status, `bl ${prefix}strlen\n`);
			emit_asm(status, `mov x1, x0\n`);
			emit_asm(status, `ldp x0, x30, [sp], #16\n`);
		} else if (
			node.return_type.name.startsWith("float") ||
			node.return_type.name.startsWith("ufloat")
		) {
			// A float-returning extern returns d0 — move the bits back to x0.
			emit_asm(status, `fmov x0, d0\n`);
		}
	}

	emit_asm(status, `ldp x29, x30, [sp], #16\n`);
	emit_asm(status, `ret\n`);
	emit_asm(status, `\n`);
}
