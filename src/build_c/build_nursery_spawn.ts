import { mono_type_name } from "../build_common/mono_name.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import build_node from "./build_node.ts";
import { POOL_HEADER } from "./build_spawn_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

/**
 * Build a `name.spawn(fn(args))` escape-hatch call (C backend).
 *
 * Mirrors build_spawn_node, but the future is registered with the nursery
 * referenced by the receiver (`nursery_ptr`, a `struct Nursery *`) at runtime
 * — reading `futures_ptr` / `count_ptr` — instead of a compile-time-known
 * async-block ID. The enclosing async block's join loop reads the same array
 * and count slots, so futures spawned through a passed Nursery are joined at
 * the block's scope exit exactly like direct spawns.
 *
 * The single parameter is the call expression to spawn (same shape as bare
 * `spawn fn(args)`). See ASYNC.md, "Escape hatch: passing the nursery".
 */
export default function build_nursery_spawn(
	node: AccessFunctionCallNode,
	nursery_ptr: string,
	status: BuildStatus,
) {
	if (node.params.length !== 1 || node.params[0].node_type !== "func_call") return;
	const call = node.params[0] as FunctionCallNode;
	const func_name = c_function_name(call.name);
	const args = call.params;

	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	// Emit pool infrastructure on first spawn (file scope, deduped).
	if (!status.headers.includes("__nomen_pool_submit")) {
		status.headers += POOL_HEADER;
	}

	const struct_name = `__nomen_spawn_${id}_args`;
	const tramp_name = `__nomen_spawn_${id}_trampoline`;

	// Resolve each arg's C type (classes/traits are pointers).
	const arg_c_types: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg_type = type_from_value_node(args[i]);
		const mono_name = mono_type_name(arg_type);
		const is_class = !!status.structs.find((s) => s.name === mono_name && s.is_class);
		const is_trait = !!status.traits.find((t) => t.name === mono_name);
		arg_c_types.push(is_class || is_trait ? `struct ${mono_name} *` : c_type(mono_name));
	}

	// Determine the return type up front (shared by the forward declaration
	// and the trampoline's result capture).
	const return_type_name = node.function_return_type?.name;
	const returns_value = !!(
		return_type_name &&
		return_type_name !== "void" &&
		return_type_name !== "?"
	);
	const is_class_ret =
		returns_value && !!status.structs.find((s) => s.name === return_type_name && s.is_class);
	const is_trait_ret = returns_value && !!status.traits.find((t) => t.name === return_type_name);
	const c_ret_type = !returns_value
		? "void"
		: is_class_ret || is_trait_ret
			? `struct ${return_type_name} *`
			: c_type(return_type_name);

	// Forward-declare the spawned function before the trampoline: the
	// trampoline is a full function definition appended to the headers, and
	// it may be appended BEFORE the function's own prototype lands there —
	// struct methods are built before free functions, so a spawn inside a
	// method (e.g. a monomorphized generic body) emits its trampoline ahead
	// of any free function declared after the generic struct. A compatible
	// redeclaration is legal C, so emitting this unconditionally is safe.
	// Mirrors the aarch64 companion's trampoline declaration.
	//
	// Emit the arg struct + trampoline to headers (file scope). Identical to
	// build_spawn_node — the trampoline is shared across both spawn forms.
	let header = `${c_ret_type} ${func_name}(${arg_c_types.join(", ")});\n`;
	header += `struct ${struct_name} {\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		header += `\t${arg_c_types[i]} arg${i};\n`;
	}
	header += `\tunsigned long long *result_slot;\n`;
	header += `\tunsigned long long *cancel_flag;\n`;
	header += `\tstruct nomen_future *future;\n`;
	header += `};\n`;
	header += `static void ${tramp_name}(void *p) {\n`;
	header += `\tstruct ${struct_name} *a = (struct ${struct_name} *)p;\n`;
	header += `\t__nomen_current_cancel_flag = a->cancel_flag;\n`;
	if (returns_value) {
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
	header += `\t__nomen_current_cancel_flag = NULL;\n`;
	header += `\tpthread_mutex_lock(&a->future->mu);\n`;
	header += `\ta->future->done = 1;\n`;
	header += `\tpthread_cond_broadcast(&a->future->cv);\n`;
	header += `\tpthread_mutex_unlock(&a->future->mu);\n`;
	header += `\t__nomen_future_release(a->future);\n`; // a freed via f->owner_args at last release
	header += `}\n`;
	status.headers += header;

	// The future always has a nursery reference here (that's the point of the
	// escape hatch), plus the trampoline and — for the captured form — the Task.
	const fire_and_forget = !!node.is_statement;
	const refs = fire_and_forget ? 2 : 3;

	// Resolve the monomorphized Task struct name for the captured form.
	const task_type_args = node.type?.type_args;
	const mono_task_name = mono_type_name("Task", task_type_args);

	// Statement-expression: set up args, allocate the future, submit, register
	// with the nursery (runtime futures/count pointers), optionally yield Task.
	status.code += `({\n`;
	status.code += `\tstruct ${struct_name} *_args = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	for (let i = 0; i < args.length; i++) {
		status.code += `\t_args->arg${i} = `;
		build_node(args[i], status);
		status.code += ";\n";
	}
	status.code += `\tunsigned long long *_result_ptr = (unsigned long long *)malloc(sizeof(unsigned long long));\n`;
	status.code += `\t*_result_ptr = 0;\n`;
	status.code += `\t_args->result_slot = _result_ptr;\n`;
	status.code += `\tunsigned long long *_cancel_ptr = (unsigned long long *)malloc(sizeof(unsigned long long));\n`;
	status.code += `\t*_cancel_ptr = 0;\n`;
	status.code += `\t_args->cancel_flag = _cancel_ptr;\n`;
	status.code += `\tstruct nomen_future *_future = (struct nomen_future *)malloc(sizeof(struct nomen_future));\n`;
	status.code += `\tpthread_mutex_init(&_future->mu, NULL);\n`;
	status.code += `\tpthread_cond_init(&_future->cv, NULL);\n`;
	status.code += `\t_future->done = 0;\n`;
	status.code += `\t_future->cancel_flag = _cancel_ptr;\n`;
	status.code += `\t_future->result_slot = _result_ptr;\n`;
	status.code += `\t_future->refs = ${refs};\n`;
	status.code += `\t_args->future = _future;\n`;
	status.code += `\t_future->owner_args = _args;\n`;
	status.code += `\t__nomen_pool_submit(${tramp_name}, _args);\n`;
	// Register the future with the nursery via its runtime pointers. The
	// enclosing async block's join loop reads the same array + count. The
	// pointer expression is parenthesized so `&struct` (the magic-identifier
	// case) binds correctly against the trailing `->`.
	status.code += `\t((unsigned long long *)(${nursery_ptr})->futures_ptr)[(*(int *)(${nursery_ptr})->count_ptr)++] = (unsigned long long)_future;\n`;
	if (fire_and_forget) {
		status.code += `\t(void)0;\n`;
	} else {
		status.code += `\tstruct ${mono_task_name} *_task = (struct ${mono_task_name} *)malloc(sizeof(struct ${mono_task_name}));\n`;
		status.code += `\t_task->handle = 0;\n`;
		status.code += `\t_task->done = 0;\n`;
		status.code += `\t_task->result_slot = (unsigned long long)_result_ptr;\n`;
		status.code += `\t_task->cancel_flag = (unsigned long long)_cancel_ptr;\n`;
		status.code += `\t_task->future = (unsigned long long)_future;\n`;
		status.code += `\t_task;\n`;
	}
	status.code += `})\n`;
}
