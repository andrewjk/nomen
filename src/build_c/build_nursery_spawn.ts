import { mono_type_name } from "../build_common/mono_name.ts";
import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import build_node from "./build_node.ts";
import { ensure_concurrency_runtime } from "./build_spawn_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/**
 * Build a `name.start(Thread(fn(args)))` escape-hatch call (C backend,
 * docs/CLOSURE_PLAN.md Phase 3b).
 *
 * The single parameter is the `Thread(fn(args))` construction (or a
 * Thread-typed expression) — its fields carry the task closure packed
 * eagerly at the construction site, plus the result slot, cancel flag, and
 * future. This submits the packed closure, registers the future with the
 * nursery referenced by the receiver (`nursery_ptr`, a `struct Nursery *`)
 * — reading `futures_ptr` / `count_ptr` — transfers the handles out of the
 * instance, and yields Task<T>. The enclosing async block's join loop reads
 * the same array and count slots, so futures spawned through a passed
 * Nursery are joined at the block's scope exit exactly like direct spawns.
 *
 * See ASYNC.md, "Escape hatch: passing the nursery".
 */
export default function build_nursery_spawn(
	node: AccessFunctionCallNode,
	nursery_ptr: string,
	status: BuildStatus,
) {
	if (node.params.length !== 1) return;
	const fire_and_forget = !!node.is_statement;
	const refs = fire_and_forget ? 2 : 3;

	ensure_concurrency_runtime(status);

	const t_arg = spawn_result_type_arg(node.function_return_type);
	const mono_thread = mono_type_name("Thread", [t_arg]);
	const mono_task_name = mono_type_name("Task", [t_arg]);

	// A `pool.start(Thread(fn(args)))` argument is a TEMPORARY instance —
	// free it after transferring the handles; a stored binding is freed by
	// its owner.
	const arg = node.params[0];
	const arg_is_temp =
		arg.node_type === "func_call" &&
		!!((arg as FunctionCallNode).is_thread_ctor || (arg as FunctionCallNode).is_fiber_ctor);
	status.code += `({\n`;
	status.code += `\tstruct ${mono_thread} *_self = `;
	build_node(arg, status);
	status.code += `;\n`;
	status.code += `\tstruct nomen_future *_future = (struct nomen_future *)_self->future;\n`;
	status.code += `\tvoid *_result_ptr = (void *)_self->result_slot;\n`;
	status.code += `\tunsigned long long *_cancel_ptr = (unsigned long long *)_self->cancel_flag;\n`;
	status.code += `\tstruct nomen_closure *_closure = (struct nomen_closure *)_self->task;\n`;
	// The construction's own reference is consumed by the launch (this is a
	// nursery-registered spawn: trampoline + Task [+ the instance's slot
	// handed to the nursery side]).
	status.code += `\t_future->refs = ${refs};\n`;
	status.code += `\t__nomen_pool_submit(_closure);\n`;
	// Register the future with the nursery via its runtime pointers — the
	// growable-list helper (the pointers address the enclosing async block's
	// storage/count/capacity slots, so a realloc updates the block's own list
	// in place). The pointer expressions are parenthesized so `&struct` (the
	// magic-identifier case) binds correctly against the trailing `->`.
	status.code += `\t__nomen_nursery_track((void **)(${nursery_ptr})->futures_ptr, (int *)(${nursery_ptr})->count_ptr, (int *)(${nursery_ptr})->cap_ptr, _future);\n`;
	// Transfer the handles out of the instance (started; #destroy no-ops).
	status.code += `\t_self->task = 0;\n`;
	status.code += `\t_self->future = 0;\n`;
	status.code += `\t_self->result_slot = 0;\n`;
	status.code += `\t_self->cancel_flag = 0;\n`;
	status.code += `\t_self->started = 1;\n`;
	if (arg_is_temp) status.code += `\tfree(_self);\n`;
	if (fire_and_forget) {
		status.code += `\t(void)0;\n`;
	} else {
		status.code += `\tstruct ${mono_task_name} *_task = (struct ${mono_task_name} *)malloc(sizeof(struct ${mono_task_name}));\n`;
		status.code += `\t_task->_vt = &_${mono_task_name}_traits;\n`;
		status.code += `\t_task->handle = 0;\n`;
		status.code += `\t_task->done = 0;\n`;
		status.code += `\t_task->result_slot = (unsigned long long)_result_ptr;\n`;
		status.code += `\t_task->cancel_flag = (unsigned long long)_cancel_ptr;\n`;
		status.code += `\t_task->future = (unsigned long long)_future;\n`;
		status.code += `\t_task;\n`;
	}
	status.code += `})\n`;
}

/** The launch's T as a Type: the stamped wrapped-call return type, with
 *  void coerced to uint64 (Task's result-slot convention). */
function spawn_result_type_arg(return_type: { name?: string } | undefined): Type {
	return return_type?.name && return_type.name !== "void" && return_type.name !== "?"
		? new Type(return_type.name)
		: new Type("uint64");
}
