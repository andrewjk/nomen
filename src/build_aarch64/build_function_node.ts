import type BuildStatus from "../build/BuildStatus.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import build_block_node from "./build_block_node.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

export default function build_function_node(node: FunctionNode, status: BuildStatus) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = [];

	const param_regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];
	status.function_param_regs = new Map();
	status.function_param_vars = new Set();
	for (let i = 0; i < node.params.length; i++) {
		status.function_param_regs.set(node.params[i].name, param_regs[i]);
		if (node.params[i].declaration === "var") {
			status.function_param_vars.add(node.params[i].name);
		}
	}

	const old_return_label = status.function_return_label;
	const return_label = `.return_${label_counter++}`;
	status.function_return_label = return_label;

	const is_nested = !!old_return_label && node.name !== "main";
	
	// Swap code buffer for nested functions
	let old_code: string | undefined;
	if (is_nested) {
		old_code = status.code;
		status.code = "";
	}

	// Check if return type is a non-simple struct
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

	status.code += `.p2align 2\n`;
	status.code += `${node.name}:\n`;
	status.code += `stp x29, x30, [sp, #-16]!\n`;
	const stack_placeholder = `STACK_SIZE_${node.name}`;
	status.code += `sub sp, sp, #${stack_placeholder}\n`;
	status.code += `mov x29, sp\n`;

	build_block_node(node, status);

	status.code += `${return_label}:\n`;
	if (node.name === "main") {
		status.code += `mov x0, #0\n`;
	}
	// Restore stack and frame
	const total_stack = Math.ceil((status.stack_size || 0) / 16) * 16;
	status.code = status.code.replace(
		`sub sp, sp, #${stack_placeholder}`,
		total_stack > 0 ? `sub sp, sp, #${total_stack}` : `// no stack needed`,
	);
	if (total_stack > 0) {
		status.code += `add sp, sp, #${total_stack}\n`;
	}
	status.code += `ldp x29, x30, [sp], #16\n`;
	status.code += `ret\n`;

	// For nested functions, save the code to nested_functions buffer and restore original
	if (is_nested) {
		if (!status.nested_functions) status.nested_functions = "";
		status.nested_functions += status.code;
		status.code = old_code!;
	}

	// Append nested functions and data after the current function
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
