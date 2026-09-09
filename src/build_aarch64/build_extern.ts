import type BuildStatus from "../build_c/BuildStatus.ts";
import emission_label from "../build_common/emission_label.ts";
import { is_overloaded, mangled_label } from "../check/utils/function_overload.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";

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
	const symbol = `${prefix}${node.name.replace(/#/g, "")}`;

	const float_params = node.params.filter(
		(p) => !p.is_variadic && (p.type.name.startsWith("float") || p.type.name.startsWith("ufloat")),
	);
	const use_float = float_params.length === 1 && node.params.length === 1;

	status.code += `.p2align 2\n`;
	status.code += `.globl ${label}\n`;
	status.code += `${label}:\n`;
	if (status.platform !== "windows") {
		status.code += `.globl _${label}\n`;
		status.code += `_${label} = ${label}\n`;
	}
	status.code += `stp x29, x30, [sp, #-16]!\n`;
	status.code += `mov x29, sp\n`;

	if (use_float) {
		// (float x) -> symbol(d0); bits arrive in x0.
		status.code += `fmov d0, x0\n`;
		status.code += `bl ${symbol}\n`;
		if (node.return_type.name) {
			status.code += `fmov x0, d0\n`;
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
				status.code += `mov x${out}, x${inc}\n`;
			}
		}
		status.code += `bl ${symbol}\n`;

		if (node.return_type.name === "string") {
			// Wrap the returned char* into the fat (ptr, len) pair: x0 = ptr.
			// strlen clobbers x0 and x30, so spill the pointer and the
			// adapter-internal return address first.
			status.code += `stp x0, x30, [sp, #-16]!\n`;
			status.code += `bl ${prefix}strlen\n`;
			status.code += `mov x1, x0\n`;
			status.code += `ldp x0, x30, [sp], #16\n`;
		} else if (
			node.return_type.name.startsWith("float") ||
			node.return_type.name.startsWith("ufloat")
		) {
			// A float-returning extern returns d0 — move the bits back to x0.
			status.code += `fmov x0, d0\n`;
		}
	}

	status.code += `ldp x29, x30, [sp], #16\n`;
	status.code += `ret\n`;
	status.code += `\n`;
}
