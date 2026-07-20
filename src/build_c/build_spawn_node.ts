import SpawnNode from "../nodes/SpawnNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

/**
 * Build a `spawn <call>` node. Returns a Task value (via GCC statement
 * expression) so spawn can be used either as a statement (value discarded)
 * or as an expression (`let t = spawn fn(args)`).
 *
 * Behavior:
 * - Outside a nursery: the returned Task owns the pthread handle. Caller
 *   must `wait()` to join (otherwise the handle leaks).
 * - Inside a nursery: the nursery takes ownership of the handle (joins it
 *   at block exit). The returned Task is a placeholder with handle=0 —
 *   calling `wait()` on it is a safe no-op.
 */
export default function build_spawn_node(node: SpawnNode, status: BuildStatus) {
	const call = node.call;
	const func_name = c_function_name(call.name);
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	// pthread.h has include guards, so re-adding across multiple spawns is fine.
	if (!status.headers.includes("#include <pthread.h>")) {
		status.headers = `#include <pthread.h>\n` + status.headers;
	}

	const struct_name = `__echo_spawn_${id}_args`;
	const tramp_name = `__echo_spawn_${id}_trampoline`;

	// Resolve each arg's C type. Classes/traits are pointers; primitives and
	// by-value structs use c_type's output directly.
	const arg_c_types: string[] = [];
	for (let i = 0; i < call.params.length; i++) {
		const arg_type = type_from_value_node(call.params[i]);
		const is_class = !!status.structs.find((s) => s.name === arg_type.name && s.is_class);
		const is_trait = !!status.traits.find((t) => t.name === arg_type.name);
		arg_c_types.push(
			is_class || is_trait ? `struct ${arg_type.name} *` : c_type(arg_type.name),
		);
	}

	// Emit the arg struct + trampoline to headers (file scope).
	// The args struct also carries a result slot pointer that the trampoline
	// writes the function's return value to (cast to uint64), and a cancel
	// flag pointer that the trampoline publishes to a thread-local so the
	// spawned function can poll Task.current_cancelled().
	let header = `struct ${struct_name} {\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		header += `\t${arg_c_types[i]} arg${i};\n`;
	}
	header += `\tunsigned long long *result_slot;\n`;
	header += `\tunsigned long long *cancel_flag;\n`;
	header += `};\n`;
	header += `static void *${tramp_name}(void *p) {\n`;
	header += `\tstruct ${struct_name} *a = (struct ${struct_name} *)p;\n`;
	header += `\t__echo_current_cancel_flag = a->cancel_flag;\n`;
	// Determine if the function returns a value. We approximate by checking
	// the captured function_return_type — empty name means void/no return.
	const return_type_name = node.function_return_type?.name;
	const returns_value = !!(return_type_name && return_type_name !== "void" && return_type_name !== "?");
	if (returns_value) {
		const is_class_ret = !!status.structs.find((s) => s.name === return_type_name && s.is_class);
		const is_trait_ret = !!status.traits.find((t) => t.name === return_type_name);
		const c_ret_type =
			is_class_ret || is_trait_ret ? `struct ${return_type_name} *` : c_type(return_type_name);
		header += `\t${c_ret_type} _r = ${func_name}(`;
	} else {
		header += `\t${func_name}(`;
	}
	for (let i = 0; i < arg_c_types.length; i++) {
		if (i > 0) header += ", ";
		header += `a->arg${i}`;
	}
	header += ");\n";
	if (returns_value) {
		header += `\t*(a->result_slot) = (unsigned long long)_r;\n`;
	}
	header += `\t__echo_current_cancel_flag = NULL;\n`;
	header += `\tfree(a);\n`;
	header += `\treturn NULL;\n`;
	header += `}\n`;
	status.headers += header;

	// Statement-expression that sets up the args, spawns, and yields a Task.
	// GCC statement expressions (`({ ... })`) are supported by clang.
	status.code += `({\n`;
	status.code += `\tstruct ${struct_name} *_args = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	for (let i = 0; i < call.params.length; i++) {
		status.code += `\t_args->arg${i} = `;
		build_node(call.params[i], status);
		status.code += ";\n";
	}
	status.code += `\tunsigned long long *_result_ptr = (unsigned long long *)malloc(sizeof(unsigned long long));\n`;
	status.code += `\t*_result_ptr = 0;\n`;
	status.code += `\t_args->result_slot = _result_ptr;\n`;
	status.code += `\tunsigned long long *_cancel_ptr = (unsigned long long *)malloc(sizeof(unsigned long long));\n`;
	status.code += `\t*_cancel_ptr = 0;\n`;
	status.code += `\t_args->cancel_flag = _cancel_ptr;\n`;
	status.code += `\tpthread_t _handle;\n`;
	status.code += `\tpthread_create(&_handle, NULL, ${tramp_name}, _args);\n`;

	// Inside a nursery: nursery takes ownership of the handle. Outside: the
	// returned Task owns it (caller must wait).
	const nursery_id = status.nursery_stack?.at(-1);
	if (nursery_id !== undefined) {
		status.code += `\t__echo_nursery_${nursery_id}_handles[__echo_nursery_${nursery_id}_count++] = _handle;\n`;
		status.code += `\t(struct Task){.handle = 0, .done = 1, .result_slot = (unsigned long long)_result_ptr, .cancel_flag = (unsigned long long)_cancel_ptr};\n`;
	} else {
		status.code += `\t(struct Task){.handle = (unsigned long long)_handle, .done = 0, .result_slot = (unsigned long long)_result_ptr, .cancel_flag = (unsigned long long)_cancel_ptr};\n`;
	}
	status.code += `})\n`;
}
