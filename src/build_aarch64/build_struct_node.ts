import type BuildStatus from "../build/BuildStatus.ts";
import StructNode from "../nodes/StructNode.ts";
import build_block_node from "./build_block_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";
import { get_field_offset } from "./utils/struct_layout.ts";

export default function build_struct_node(node: StructNode, status: BuildStatus) {
	const is_nested = !!status.function_return_label;

	let old_code: string | undefined;
	if (is_nested) {
		old_code = status.code;
		status.code = "";
	}

	if (node.is_simple_type) {
		build_struct_functions(node, status);
	} else {
		build_init_function(node, status);
		build_struct_functions(node, status);
	}

	if (is_nested) {
		if (!status.nested_functions) status.nested_functions = "";
		status.nested_functions += status.code;
		status.code = old_code!;
	}
}

function build_init_function(node: StructNode, status: BuildStatus) {
	const func_name = `${node.name}_init`;
	const required_fields = node.fields.filter((f) => f.value == null);

	const old_stack_size = status.stack_size;
	const old_stack_offsets = status.stack_offsets;
	status.stack_size = 0;
	status.stack_offsets = new Map();

	status.code += `.p2align 2\n`;
	status.code += `${func_name}:\n`;
	status.code += `stp x29, x30, [sp, #-16]!\n`;
	status.code += `mov x29, sp\n`;

	status.code += `str xzr, [x0]\n`;

	const param_regs = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
	for (let i = 0; i < required_fields.length; i++) {
		const field = required_fields[i];
		const offset = get_field_offset(node.name, field.name, status);
		status.code += `str ${param_regs[i]}, [x0, #${offset}]\n`;
	}

	for (const field of node.fields) {
		if (field.value) {
			const offset = get_field_offset(node.name, field.name, status);
			if (field.value.node_type === "value") {
				const val = (field.value as any).value;
				if (val === "true") {
					status.code += `mov x1, #1\n`;
				} else if (val === "false") {
					status.code += `mov x1, #0\n`;
				} else if (/^(\+|-)*\d+$/.test(val)) {
					status.code += `ldr x1, =${val}\n`;
				} else if (val.startsWith('"')) {
					const label = `_str_${func_name}_${field.name}`;
					status.strings!.set(label, val);
					status.code += `adr x1, ${label}\n`;
				} else {
					status.code += `ldr x1, =${val}\n`;
				}
				status.code += `str x1, [x0, #${offset}]\n`;
			}
		}
	}

	status.code += `.return_${func_name}:\n`;
	status.code += `ldp x29, x30, [sp], #16\n`;
	status.code += `ret\n`;

	status.stack_size = old_stack_size;
	status.stack_offsets = old_stack_offsets;
}


function build_struct_functions(node: StructNode, status: BuildStatus) {
	for (const func of node.functions) {
		if (func.name === "init") continue;

		const old_scoped_declarations = status.scoped_declarations;
		const old_stack_size = status.stack_size;
		const old_stack_offsets = status.stack_offsets;
		const old_param_regs = status.function_param_regs;
		const old_param_vars = status.function_param_vars;
		const old_return_label = status.function_return_label;

		status.scoped_declarations = [];
		status.stack_size = 0;
		status.stack_offsets = new Map();

		const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];

		const return_label = `.return_${node.name}_${func.name}`;
		status.function_return_label = return_label;

		const func_label = `${node.name}_${func.name}`;
		const stack_placeholder = `STACK_SIZE_${func_label}`;

		status.code += `.p2align 2\n`;
		status.code += `${func_label}:\n`;
		status.code += `stp x29, x30, [sp, #-16]!\n`;

		const is_self_param = func.params[0]?.is_self_param;
		const self_is_var = is_self_param && func.params[0]?.declaration === "var";
		const needs_x19 = is_self_param && !self_is_var;
		if (needs_x19) {
			status.code += `str x19, [sp, #-16]!\n`;
			status.code += `mov x19, x0\n`;
		}

		const callee_saved = ["x19", "x20", "x21", "x22"];
		let callee_idx = 0;
		if (needs_x19) {
			callee_idx = 1;
		}

		status.function_param_regs = new Map();
		status.function_param_vars = new Set();
		status.struct_return_buffer = undefined;

		const return_struct = status.structs.find(
			(s) => s.name === func.return_type?.name && !s.is_simple_type,
		);
		if (return_struct) {
			status.struct_return_buffer = "x8";
		}

		if (needs_x19) {
			status.function_param_regs.set("self", "x19");
		}

		for (let i = 0; i < func.params.length; i++) {
			const param = func.params[i];
			if (param.is_self_param && !self_is_var) continue;
			const is_struct_type = !!status.structs.find(
				(s) => s.name === param.type.name && !s.is_simple_type,
			);
			if (is_struct_type && callee_idx < callee_saved.length) {
				const saved_reg = callee_saved[callee_idx++];
				if (saved_reg !== "x19" || !needs_x19) {
					status.code += `str ${saved_reg}, [sp, #-16]!\n`;
				}
				status.code += `mov ${saved_reg}, ${param_regs[i]}\n`;
				status.function_param_regs.set(param.name, saved_reg);
			} else {
				// Non-struct params will be saved after stack allocation
			}
			if (param.declaration === "var") {
				status.function_param_vars.add(param.name);
			}
		}

		status.code += `sub sp, sp, #${stack_placeholder}\n`;
		status.code += `mov x29, sp\n`;

		// Save non-struct params and var self to stack now that x29 is set
		for (let i = 0; i < func.params.length; i++) {
			const param = func.params[i];
			if (param.is_self_param && !self_is_var) continue;
			const is_struct_type = !!status.structs.find(
				(s) => s.name === param.type.name && !s.is_simple_type,
			);
			if (!is_struct_type) {
				const size = aarch64_size(param.type.name);
				const offset = allocate_stack_space(status, size, size);
				status.stack_offsets!.set(param.name, offset);
				const save_reg = param.is_self_param ? (needs_x19 ? "x19" : param_regs[i]) : param_regs[i];
				status.code += `str ${save_reg}, [x29, #${offset}]\n`;
			}
		}

		build_block_node(func, status);

		status.code += `${return_label}:\n`;

		const total_stack = Math.ceil((status.stack_size || 0) / 16) * 16;
		status.code = status.code.replace(
			`sub sp, sp, #${stack_placeholder}`,
			total_stack > 0 ? `sub sp, sp, #${total_stack}` : `// no stack needed`,
		);
		if (total_stack > 0) {
			status.code += `add sp, sp, #${total_stack}\n`;
		}

		for (let ci = callee_idx - 1; ci >= 0; ci--) {
			if (callee_saved[ci] === "x19" && needs_x19) continue;
			status.code += `ldr ${callee_saved[ci]}, [sp], #16\n`;
		}
		if (needs_x19) {
			status.code += `ldr x19, [sp], #16\n`;
		}
		status.code += `ldp x29, x30, [sp], #16\n`;
		status.code += `ret\n`;

		status.scoped_declarations = old_scoped_declarations;
		status.function_param_regs = old_param_regs;
		status.function_param_vars = old_param_vars;
		status.function_return_label = old_return_label;
		status.struct_return_buffer = undefined;
		status.stack_size = old_stack_size;
		status.stack_offsets = old_stack_offsets;
	}
}
