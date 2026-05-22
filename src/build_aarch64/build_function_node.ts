import type BuildStatus from "../build/BuildStatus.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import build_block_node from "./build_block_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

export default function build_function_node(node: FunctionNode, status: BuildStatus) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = [];

	const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];

	const old_return_label = status.function_return_label;
	const return_label = `.return_${label_counter++}`;
	status.function_return_label = return_label;

	const is_nested = !!old_return_label && node.name !== "main";

	let old_code: string | undefined;
	if (is_nested) {
		old_code = status.code;
		status.code = "";
	}

	const return_struct = status.structs.find(
		(s) => s.name === node.return_type.name && !s.is_simple_type,
	);
	if (return_struct) {
		status.struct_return_buffer = "x8";
	}

	const old_stack_size = status.stack_size;
	const old_stack_offsets = status.stack_offsets;
	status.stack_size = 0;
	status.stack_offsets = new Map();

	const has_body = node.has_body && node.statements.length > 0;

	const callee_saved = ["x19", "x20", "x21", "x22"];
	const callee_map = new Map<string, string>();
	let callee_idx = 0;

	status.code += `.p2align 2\n`;
	status.code += `${node.name}:\n`;
	status.code += `stp x29, x30, [sp, #-16]!\n`;

	if (has_body) {
		for (let i = 0; i < node.params.length; i++) {
			const param = node.params[i];
			const is_struct_type = !!status.structs.find(
				(s) => s.name === param.type.name && !s.is_simple_type,
			);
			if (is_struct_type && callee_idx < callee_saved.length) {
				const saved_reg = callee_saved[callee_idx++];
				status.code += `str ${saved_reg}, [sp, #-16]!\n`;
				status.code += `mov ${saved_reg}, ${param_regs[i]}\n`;
				callee_map.set(param.name, saved_reg);
			}
		}
	}

	const stack_placeholder = `STACK_SIZE_${node.name}`;
	status.code += `sub sp, sp, #${stack_placeholder}\n`;
	status.code += `mov x29, sp\n`;

	status.function_param_regs = new Map();
	status.function_param_vars = new Set();
	status.function_array_params = new Set();
	status.function_ref_params = new Set();

	if (has_body) {
		for (let i = 0; i < node.params.length; i++) {
			const param = node.params[i];
			if (callee_map.has(param.name)) {
				status.function_param_regs.set(param.name, callee_map.get(param.name)!);
			} else {
				const size = aarch64_size(param.type.name);
				const offset = allocate_stack_space(status, size, size);
				status.stack_offsets!.set(param.name, offset);
				const reg = param_regs[i];
				if (size === 1) {
					status.code += `strb ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
				} else if (size === 4) {
					status.code += `str ${reg.replace("x", "w")}, [x29, #${offset}]\n`;
				} else {
					status.code += `str ${reg}, [x29, #${offset}]\n`;
				}
			}
			if (param.declaration === "var") {
				status.function_param_vars.add(param.name);
			}
			if (param.type.is_array) {
				status.function_array_params!.add(param.name);
			}
			if (param.type.is_ref) {
				status.function_ref_params!.add(param.name);
			}
		}
	}

	build_block_node(node, status);

	status.code += `${return_label}:\n`;
	if (node.name === "main") {
		status.code += `mov x0, #0\n`;
	}
	const total_stack = Math.ceil((status.stack_size || 0) / 16) * 16;
	status.code = status.code.replace(
		`sub sp, sp, #${stack_placeholder}`,
		total_stack > 0 ? `sub sp, sp, #${total_stack}` : `// no stack needed`,
	);
	if (total_stack > 0) {
		status.code += `add sp, sp, #${total_stack}\n`;
	}

	for (let ci = callee_idx - 1; ci >= 0; ci--) {
		status.code += `ldr ${callee_saved[ci]}, [sp], #16\n`;
	}

	status.code += `ldp x29, x30, [sp], #16\n`;
	status.code += `ret\n`;

	if (is_nested) {
		if (!status.nested_functions) status.nested_functions = "";
		status.nested_functions += status.code;
		status.code = old_code!;
	}

	if (status.function_data) {
		status.code += status.function_data;
		status.function_data = undefined;
	}
	if (status.nested_functions && !is_nested) {
		status.code += status.nested_functions;
		status.nested_functions = undefined;
	}

	status.scoped_declarations = old_scoped_declarations;
	status.stack_size = old_stack_size;
	status.stack_offsets = old_stack_offsets;
	status.function_param_regs = undefined;
	status.function_param_vars = undefined;
	status.function_return_label = old_return_label;
	status.struct_return_buffer = undefined;
}
