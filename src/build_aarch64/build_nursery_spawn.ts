import type BuildStatus from "../build_c/BuildStatus.ts";
import c_function_name from "../build_c/utils/c_function_name.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import { POOL_HEADER_C } from "./build_spawn_node.ts";
import { emit_deref_var_address, emit_var_address } from "./utils/stack_var.ts";

/**
 * Build a `name.spawn(fn(args))` escape-hatch call for aarch64.
 *
 * Mirrors build_spawn_node (aarch64): the per-site trampoline + submit helper
 * are emitted as C in the companion file; the assembly builds the arg struct
 * and calls the helper. The difference is that the nursery's futures/count
 * addresses are loaded at runtime from the receiver Nursery struct (rather
 * than compile-time-known stack offsets), since the spawn may happen inside a
 * function that received the nursery as a `ref Nursery` parameter.
 *
 * The single parameter is the call expression to spawn (same shape as bare
 * `spawn fn(args)`). See ASYNC.md, "Escape hatch: passing the nursery".
 */
export default function build_nursery_spawn(
	node: AccessNode,
	access_func: AccessFunctionCallNode,
	status: BuildStatus,
) {
	if (access_func.params.length !== 1 || access_func.params[0].node_type !== "func_call") return;
	const call = access_func.params[0] as FunctionCallNode;
	const func_name = c_function_name(call.name);
	const args = call.params;

	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	if (!status.file_scope_c?.includes("__echo_pool_submit")) {
		status.file_scope_c = (status.file_scope_c ?? "") + POOL_HEADER_C;
	}

	const struct_name = `__echo_spawn_${id}_args`;
	const tramp_name = `__echo_spawn_${id}_trampoline`;
	const submit_name = `echo_spawn_${id}_submit`;

	// Resolve each arg's C type.
	const arg_c_types: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg_type = type_from_value_node(args[i]);
		const mono_name = arg_type.type_args?.length
			? `${arg_type.name}_${arg_type.type_args.map((t) => t.name).join("_")}`
			: arg_type.name;
		const is_class = !!status.structs.find((s) => s.name === mono_name && s.is_class);
		const is_trait = !!status.traits.find((t) => t.name === mono_name);
		arg_c_types.push(is_class || is_trait ? `struct ${mono_name} *` : `${mono_name}`);
	}

	// Determine return type.
	const return_type_name = access_func.function_return_type?.name;
	const returns_value = !!(
		return_type_name &&
		return_type_name !== "void" &&
		return_type_name !== "?"
	);
	const is_class_ret = returns_value
		? !!status.structs.find((s) => s.name === return_type_name && s.is_class)
		: false;
	const c_ret_type = is_class_ret
		? `struct ${return_type_name} *`
		: returns_value
			? return_type_name
			: "void";

	// --- Trampoline + submit helper (C companion) ---

	let tramp_c = `// --- nursery spawn site ${id} trampoline ---\n`;
	tramp_c += `${c_ret_type} ${func_name}(`;
	for (let i = 0; i < arg_c_types.length; i++) {
		if (i > 0) tramp_c += ", ";
		tramp_c += `${arg_c_types[i]}`;
	}
	tramp_c += `);\n`;
	tramp_c += `struct ${struct_name} {\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		tramp_c += `\t${arg_c_types[i]} arg${i};\n`;
	}
	tramp_c += `\tunsigned long long *result_slot;\n`;
	tramp_c += `\tunsigned long long *cancel_flag;\n`;
	tramp_c += `\tstruct echo_future *future;\n`;
	tramp_c += `};\n`;

	tramp_c += `static void ${tramp_name}(void *p) {\n`;
	tramp_c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)p;\n`;
	tramp_c += `\t__echo_current_cancel_flag = a->cancel_flag;\n`;
	if (returns_value) {
		tramp_c += `\t${c_ret_type} _r = ${func_name}(`;
	} else {
		tramp_c += `\t${func_name}(`;
	}
	for (let i = 0; i < arg_c_types.length; i++) {
		if (i > 0) tramp_c += ", ";
		tramp_c += `a->arg${i}`;
	}
	tramp_c += `);\n`;
	if (returns_value) {
		tramp_c += `\t*(a->result_slot) = (unsigned long long)_r;\n`;
	}
	tramp_c += `\t__echo_current_cancel_flag = NULL;\n`;
	tramp_c += `\tpthread_mutex_lock(&a->future->mu);\n`;
	tramp_c += `\ta->future->done = 1;\n`;
	tramp_c += `\tpthread_cond_broadcast(&a->future->cv);\n`;
	tramp_c += `\tpthread_mutex_unlock(&a->future->mu);\n`;
	tramp_c += `\t__echo_future_release(a->future);\n`;
	tramp_c += `\tfree(a);\n`;
	tramp_c += `}\n`;

	// A nursery.spawn always tracks its future with a nursery (that's the
	// point), so the submit helper always takes the futures/count pointers.
	const fire_and_forget = !!access_func.is_statement;
	const refs = fire_and_forget ? 2 : 3;

	tramp_c += `void *${submit_name}(`;
	for (let i = 0; i < arg_c_types.length; i++) {
		if (i > 0) tramp_c += ", ";
		tramp_c += `${arg_c_types[i]} arg${i}`;
	}
	if (arg_c_types.length > 0) tramp_c += ", ";
	tramp_c += `unsigned long long *__echo_nursery_futures, int *__echo_nursery_count`;
	tramp_c += `) {\n`;
	tramp_c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		tramp_c += `\ta->arg${i} = arg${i};\n`;
	}
	tramp_c += `\ta->result_slot = (unsigned long long *)malloc(sizeof(unsigned long long));\n`;
	tramp_c += `\t*(a->result_slot) = 0;\n`;
	tramp_c += `\ta->cancel_flag = (unsigned long long *)malloc(sizeof(unsigned long long));\n`;
	tramp_c += `\t*(a->cancel_flag) = 0;\n`;
	tramp_c += `\tstruct echo_future *f = (struct echo_future *)malloc(sizeof(struct echo_future));\n`;
	tramp_c += `\tpthread_mutex_init(&f->mu, NULL);\n`;
	tramp_c += `\tpthread_cond_init(&f->cv, NULL);\n`;
	tramp_c += `\tf->done = 0;\n`;
	tramp_c += `\tf->refs = ${refs};\n`;
	tramp_c += `\tf->cancel_flag = a->cancel_flag;\n`;
	tramp_c += `\tf->result_slot = a->result_slot;\n`;
	tramp_c += `\ta->future = f;\n`;
	tramp_c += `\t__echo_pool_submit(${tramp_name}, a);\n`;
	tramp_c += `\t__echo_nursery_futures[(*__echo_nursery_count)++] = (unsigned long long)f;\n`;
	if (fire_and_forget) {
		tramp_c += `\treturn (void *)0;\n`;
	} else {
		const task_type_args = access_func.type?.type_args;
		const mono_task_name = task_type_args?.length
			? `Task_${task_type_args.map((t) => t.name).join("_")}`
			: "Task";
		tramp_c += `\tstruct ${mono_task_name} *t = (struct ${mono_task_name} *)malloc(sizeof(struct ${mono_task_name}));\n`;
		tramp_c += `\tt->handle = 0;\n`;
		tramp_c += `\tt->done = 0;\n`;
		tramp_c += `\tt->result_slot = (unsigned long long)a->result_slot;\n`;
		tramp_c += `\tt->cancel_flag = (unsigned long long)a->cancel_flag;\n`;
		tramp_c += `\tt->future = (unsigned long long)f;\n`;
		tramp_c += `\treturn t;\n`;
	}
	tramp_c += `}\n`;

	status.file_scope_c += tramp_c;

	// --- Assembly: load nursery futures/count, build args, call submit ---

	// 2 trailing args (nursery futures/count) + the function args.
	const total_arg_slots = args.length + 2;
	const raw_stack_size = total_arg_slots * 8;
	const stack_size = raw_stack_size + ((16 - (raw_stack_size % 16)) % 16);
	status.code += `// nursery spawn site ${id}\n`;
	status.code += `sub sp, sp, #${stack_size}\n`;

	// Load the Nursery struct address into x0, then load futures_ptr (offset 0)
	// and count_ptr (offset 8) and store them to the trailing arg slots.
	load_nursery_struct_address(node.target, status);
	status.code += `ldr x1, [x0, #0]\n`; // futures_ptr
	status.code += `str x1, [sp, #${args.length * 8}]\n`;
	status.code += `ldr x1, [x0, #8]\n`; // count_ptr
	status.code += `str x1, [sp, #${(args.length + 1) * 8}]\n`;

	// Build each function arg and store to its slot.
	for (let i = 0; i < args.length; i++) {
		status.code += `// Build arg${i}\n`;
		build_node(args[i], status);
		if (!status.code.endsWith("\n")) status.code += "\n";
		status.code += `str x0, [sp, #${i * 8}]\n`;
	}

	// Pop all args into registers x0..x{N-1} for the call.
	for (let i = total_arg_slots - 1; i >= 0; i--) {
		status.code += `ldr x${i}, [sp, #${i * 8}]\n`;
	}
	status.code += `add sp, sp, #${stack_size}\n`;
	status.code += `bl _${submit_name}\n`;
	// x0 = Task pointer (or NULL for fire-and-forget).
}

/**
 * Emit assembly that loads the address of the Nursery struct (the receiver of
 * a name.spawn) into x0. A `ref Nursery` parameter holds the struct address
 * (emit_deref_var_address yields it); the async block's named local lives on
 * the stack (emit_var_address yields its address); any other Nursery lvalue
 * falls back to build_node.
 */
function load_nursery_struct_address(target: AccessNode["target"], status: BuildStatus) {
	if (target.node_type === "value") {
		const name = (target as ValueNode).value;
		// ref Nursery param: the pointer it holds IS the struct address.
		if (status.function_ref_params?.has(name)) {
			emit_deref_var_address(status, "x0", name);
			return;
		}
		// Named nursery local declared by the enclosing async block.
		if (status.stack_offsets?.has(name)) {
			emit_var_address(status, "x0", name);
			return;
		}
	}
	build_node(target, status);
}
