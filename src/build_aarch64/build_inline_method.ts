import type BuildStatus from "../build_c/BuildStatus.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import RawNode from "../nodes/RawNode.ts";
import StructNode from "../nodes/StructNode.ts";
import { parse_raw_directives } from "../raw_directives.ts";
import build_block_node from "./build_block_node.ts";
import { emit_owning_buffer_inline_aarch64 } from "./utils/owning_buffer_specialize.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";

let inline_counter = 0;

export function reset_inline_counter() {
	inline_counter = 0;
}

function is_raw_only(func: FunctionNode): boolean {
	return func.statements.every((s) => s.node_type === "raw");
}

function extract_aarch64_asm(func: FunctionNode, platform: string): string {
	let asm = "";
	for (const stmt of func.statements) {
		const raw = stmt as RawNode;
		const { should_emit, code } = parse_raw_directives(raw.value, "aarch64", platform);
		if (should_emit && code) {
			if (asm) asm += "\n";
			asm += code;
		}
	}
	return asm;
}

function count_x19_reads(asm: string): number {
	const matches = asm.match(/\bx19\b/g);
	return matches ? matches.length : 0;
}

function build_naked_inline(struct_node: StructNode, func: FunctionNode, status: BuildStatus) {
	let asm = extract_aarch64_asm(func, status.platform);
	const standalone_return_label = `.return_${struct_node.name}_${func.name.replace(/#/g, "")}`;
	asm = asm.replaceAll(`b ${standalone_return_label}`, "");

	if (count_x19_reads(asm) === 1) {
		asm = asm.replace(/\bx19\b/g, "x0");
	}

	status.code += asm + "\n";
}

export default function build_inline_method(
	struct_node: StructNode,
	func: FunctionNode,
	status: BuildStatus,
) {
	// Specialize Buffer_<T> store_T / replace_T for owning value struct
	// elements (deep-copy string fields instead of plain shallow copy).
	if (emit_owning_buffer_inline_aarch64(struct_node, func.name, status)) return;

	const is_self_param = func.params[0]?.is_self_param;
	const self_is_var = is_self_param && func.params[0]?.declaration === "var";
	const needs_x19 = is_self_param && !self_is_var;

	// Raw-only inline funcs (e.g. `Math.sqrt`) emit a fixed asm snippet that
	// references the parameter registers (x0, x1, …) directly — the same
	// registers `build_access_node` already loaded the args into. The general
	// inline path below would needlessly shuffle each param into a callee-saved
	// register (x19/x20/…) that the raw body never reads, adding a
	// save/mov/restore triple per parameter. `build_naked_inline` just emits
	// the raw asm verbatim (with an x19→x0 rewrite when the body references
	// self), so prefer it for every raw-only inline func regardless of whether
	// it has a self parameter.
	if (is_raw_only(func)) {
		build_naked_inline(struct_node, func, status);
		return;
	}

	const old_scoped_declarations = status.scoped_declarations;
	const old_stack_offsets = status.stack_offsets;
	const old_param_regs = status.function_param_regs;
	const old_param_vars = status.function_param_vars;
	const old_return_label = status.function_return_label;
	const old_ref_params = status.function_ref_params;
	const old_struct_return_buffer = status.struct_return_buffer;
	const old_return_buffer_offset = status.return_buffer_stack_offset;
	const old_function_return_type = status.function_return_type;
	const old_register_allocations = status.register_allocations;
	const old_buffer_data_cache = status.buffer_data_cache;

	const return_label = `.inline_ret_${inline_counter++}`;
	status.function_return_label = return_label;

	status.scoped_declarations = [];
	status.function_return_type = undefined;
	status.struct_return_buffer = undefined;
	status.return_buffer_stack_offset = undefined;
	status.buffer_data_cache = undefined;

	if (needs_x19) {
		status.code += `str x19, [sp, #-16]!\n`;
		status.code += `mov x19, x0\n`;
	}

	const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];
	const callee_saved = ["x19", "x20", "x21", "x22"];
	let callee_idx = 0;
	if (needs_x19) {
		callee_idx = 1;
	}

	status.function_param_regs = new Map();
	status.function_param_vars = new Set();
	status.function_ref_params = new Set();

	if (needs_x19) {
		status.function_param_regs.set("self", "x19");
	}

	const saved_stack_slots: string[] = [];

	for (let i = 0; i < func.params.length; i++) {
		const param = func.params[i];
		if (param.is_self_param && !self_is_var) continue;
		// Enum-with-data args arrive as a pointer to the tag+payload blob —
		// same convention as struct args. A class arg is a heap pointer the
		// body reads as a value, so it stays in the callee-saved register path
		// (don't exclude it — see build_function_node for the full rationale).
		const is_struct_type =
			!!status.structs.find((s) => s.name === param.type.name && !s.is_simple_type) ||
			!!status.enums.find((e) => e.name === param.type.name && e.has_associated_data);
		if (is_struct_type && callee_idx < callee_saved.length) {
			const saved_reg = callee_saved[callee_idx++];
			if (saved_reg !== "x19" || !needs_x19) {
				status.code += `str ${saved_reg}, [sp, #-16]!\n`;
			}
			status.code += `mov ${saved_reg}, ${param_regs[i]}\n`;
			status.function_param_regs.set(param.name, saved_reg);
		} else if (!is_struct_type) {
			if (param.type.is_ref || callee_idx >= callee_saved.length) {
				status.code += `str ${param_regs[i]}, [sp, #-16]!\n`;
				saved_stack_slots.push(param.name);
			} else {
				const saved_reg = callee_saved[callee_idx++];
				if (saved_reg !== "x19" || !needs_x19) {
					status.code += `str ${saved_reg}, [sp, #-16]!\n`;
				}
				status.code += `mov ${saved_reg}, ${param_regs[i]}\n`;
				status.function_param_regs.set(param.name, saved_reg);
			}
		}
		if (param.declaration === "var") {
			status.function_param_vars.add(param.name);
		}
		if (param.type.is_ref) {
			status.function_ref_params!.add(param.name);
		}
	}

	const return_struct = status.structs.find(
		(s) => s.name === func.return_type?.name && !s.is_simple_type && !s.is_class,
	);
	if (return_struct) {
		status.function_return_type = func.return_type;
		status.struct_return_buffer = "x8";
		// x8 (the caller's sret destination) is caller-saved: any struct-
		// returning call inside the inline body sets its own x8, so spill the
		// incoming value to a frame slot — the return path reloads it before
		// the final struct copy (mirrors the standalone-function prologue).
		const return_buffer_stack_offset = allocate_stack_space(status, 8, 8);
		status.code += `str x8, [x29, #${return_buffer_stack_offset}]\n`;
		status.return_buffer_stack_offset = return_buffer_stack_offset;
	}

	build_block_node(func, status);

	const standalone_return_label = `.return_${struct_node.name}_${func.name.replace(/#/g, "")}`;
	status.code = status.code.replaceAll(`b ${standalone_return_label}`, `b ${return_label}`);

	status.code += `${return_label}:\n`;

	for (let i = saved_stack_slots.length - 1; i >= 0; i--) {
		status.code += `add sp, sp, #16\n`;
	}

	for (let ci = callee_idx - 1; ci >= 0; ci--) {
		if (callee_saved[ci] === "x19" && needs_x19) continue;
		status.code += `ldr ${callee_saved[ci]}, [sp], #16\n`;
	}
	if (needs_x19) {
		status.code += `ldr x19, [sp], #16\n`;
	}

	status.scoped_declarations = old_scoped_declarations;
	status.function_param_regs = old_param_regs;
	status.function_param_vars = old_param_vars;
	status.function_ref_params = old_ref_params;
	status.function_return_label = old_return_label;
	status.stack_offsets = old_stack_offsets;
	status.struct_return_buffer = old_struct_return_buffer;
	status.return_buffer_stack_offset = old_return_buffer_offset;
	status.function_return_type = old_function_return_type;
	status.register_allocations = old_register_allocations;
	status.buffer_data_cache = old_buffer_data_cache;
}

let inline_fn_depth = 0;
const MAX_INLINE_DEPTH = 2;

export function build_inline_function(func: FunctionNode, status: BuildStatus) {
	if (inline_fn_depth >= MAX_INLINE_DEPTH) return false;

	inline_fn_depth++;

	const old_scoped_declarations = status.scoped_declarations;
	const old_stack_offsets = status.stack_offsets;
	const old_param_regs = status.function_param_regs;
	const old_param_vars = status.function_param_vars;
	const old_return_label = status.function_return_label;
	const old_ref_params = status.function_ref_params;
	const old_struct_return_buffer = status.struct_return_buffer;
	const old_return_buffer_offset = status.return_buffer_stack_offset;
	const old_function_return_type = status.function_return_type;
	const old_register_allocations = status.register_allocations;
	const old_buffer_data_cache = status.buffer_data_cache;

	const return_label = `.inline_fn_ret_${inline_counter++}`;
	status.function_return_label = return_label;

	status.scoped_declarations = [];
	status.function_return_type = undefined;
	status.struct_return_buffer = undefined;
	status.return_buffer_stack_offset = undefined;
	status.buffer_data_cache = undefined;

	const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];
	const callee_saved = ["x19", "x20", "x21", "x22"];
	let callee_idx = 0;

	status.function_param_regs = new Map();
	status.function_param_vars = new Set();
	status.function_ref_params = new Set();

	const saved_stack_slots: string[] = [];

	for (let i = 0; i < func.params.length; i++) {
		const param = func.params[i];
		if (param.is_self_param) continue;
		const is_struct_type = !!status.structs.find(
			(s) => s.name === param.type.name && !s.is_simple_type,
		);
		if (is_struct_type && callee_idx < callee_saved.length) {
			const saved_reg = callee_saved[callee_idx++];
			status.code += `str ${saved_reg}, [sp, #-16]!\n`;
			status.code += `mov ${saved_reg}, ${param_regs[i]}\n`;
			status.function_param_regs.set(param.name, saved_reg);
		} else if (!is_struct_type) {
			if (param.type.is_ref || callee_idx >= callee_saved.length) {
				status.code += `str ${param_regs[i]}, [sp, #-16]!\n`;
				saved_stack_slots.push(param.name);
			} else {
				const saved_reg = callee_saved[callee_idx++];
				status.code += `str ${saved_reg}, [sp, #-16]!\n`;
				status.code += `mov ${saved_reg}, ${param_regs[i]}\n`;
				status.function_param_regs.set(param.name, saved_reg);
			}
		}
		if (param.declaration === "var") {
			status.function_param_vars.add(param.name);
		}
		if (param.type.is_ref) {
			status.function_ref_params!.add(param.name);
		}
	}

	const return_struct = status.structs.find(
		(s) => s.name === func.return_type?.name && !s.is_simple_type && !s.is_class,
	);
	if (return_struct) {
		status.function_return_type = func.return_type;
		status.struct_return_buffer = "x8";
		// See build_inline_method: spill the caller's x8 sret pointer so an
		// inner struct-returning call can't clobber it before the return copy.
		const return_buffer_stack_offset = allocate_stack_space(status, 8, 8);
		status.code += `str x8, [x29, #${return_buffer_stack_offset}]\n`;
		status.return_buffer_stack_offset = return_buffer_stack_offset;
	}

	build_block_node(func, status);

	status.code += `${return_label}:\n`;

	for (let i = saved_stack_slots.length - 1; i >= 0; i--) {
		status.code += `add sp, sp, #16\n`;
	}

	for (let ci = callee_idx - 1; ci >= 0; ci--) {
		status.code += `ldr ${callee_saved[ci]}, [sp], #16\n`;
	}

	status.scoped_declarations = old_scoped_declarations;
	status.function_param_regs = old_param_regs;
	status.function_param_vars = old_param_vars;
	status.function_ref_params = old_ref_params;
	status.function_return_label = old_return_label;
	status.stack_offsets = old_stack_offsets;
	status.struct_return_buffer = old_struct_return_buffer;
	status.return_buffer_stack_offset = old_return_buffer_offset;
	status.function_return_type = old_function_return_type;
	status.register_allocations = old_register_allocations;
	status.buffer_data_cache = old_buffer_data_cache;

	inline_fn_depth--;
	return true;
}
