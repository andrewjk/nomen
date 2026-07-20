import SpawnNode from "../nodes/SpawnNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

/**
 * Build a `spawn <call>` node. Generates a per-site arg-packing struct +
 * trampoline (emitted to headers) and submits to the thread pool inline.
 *
 * v1: fire-and-forget. The handle is detached; the trampoline frees the args
 * struct. Result-returning `Task<T>` comes later.
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

	// Emit the arg struct + trampoline to headers (file scope).
	// All fields are uint64 — Echo values are pointer-sized on every target
	// we care about, and this avoids needing to know the function's param
	// types. The trampoline casts back via the function's actual signature.
	let header = `struct ${struct_name} {\n`;
	for (let i = 0; i < call.params.length; i++) {
		header += `\tunsigned long long arg${i};\n`;
	}
	header += `};\n`;
	header += `static void *${tramp_name}(void *p) {\n`;
	header += `\tstruct ${struct_name} *a = (struct ${struct_name} *)p;\n`;
	header += `\t${func_name}(`;
	for (let i = 0; i < call.params.length; i++) {
		if (i > 0) header += ", ";
		const arg_type = type_from_value_node(call.params[i]);
		const c_arg_type = c_type(arg_type.name);
		// Cast the packed uint64 back to the function's expected arg type.
		// Class-typed args are pointers already; pass them as `(Foo*)a->argN`.
		// For class types c_type returns the struct name, which is the pointer type.
		header += `(${c_arg_type})a->arg${i}`;
	}
	header += ");\n";
	header += `\tfree(a);\n`;
	header += `\treturn NULL;\n`;
	header += `}\n`;
	status.headers += header;

	// Inline: allocate the struct, fill in args (cast to uint64), spawn + detach.
	status.code += `{\n`;
	status.code += `\tstruct ${struct_name} *_args = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	for (let i = 0; i < call.params.length; i++) {
		status.code += `\t_args->arg${i} = (unsigned long long)`;
		build_node(call.params[i], status);
		status.code += ";\n";
	}
	status.code += `\tpthread_t _handle;\n`;
	status.code += `\tpthread_create(&_handle, NULL, ${tramp_name}, _args);\n`;

	// Inside a nursery: push the handle so the async block joins it on exit.
	// Outside: detach (fire-and-forget).
	const nursery_id = status.nursery_stack?.at(-1);
	if (nursery_id !== undefined) {
		status.code += `\t__echo_nursery_${nursery_id}_handles[__echo_nursery_${nursery_id}_count++] = _handle;\n`;
	} else {
		status.code += `\tpthread_detach(_handle);\n`;
	}
	status.code += `}\n`;
}
