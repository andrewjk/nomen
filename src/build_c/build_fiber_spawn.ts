import { mono_type_name } from "../build_common/mono_name.ts";
import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import build_node from "./build_node.ts";
import { ensure_concurrency_runtime } from "./build_spawn_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

/**
 * Fiber scheduler runtime (ASYNC.md Phase 1), C backend.
 *
 * Appended immediately after POOL_HEADER (which forward-declares the fiber
 * seam, owns `__nomen_current_fiber` — Runtime.current() — and owns the
 * worker loop that drains the fiber queue between pool tasks). The context
 * switch is ucontext-based here: portable across every target the C backend
 * serves. The aarch64 backend's FIBER_HEADER_C is the same scheduler with a
 * naked-asm switch instead.
 *
 * Execution model: a fiber is a heap (or caller-provided) stack plus a
 * context. `__nomen_fiber_spawn` enqueues it; pool workers drain the fiber
 * queue between pool tasks, so a parked fiber frees its worker. In
 * cooperative mode (Fiber.set_cooperative) the spawning thread drains the
 * queue itself — no worker threads are ever started, which is the
 * no-thread/embedded path.
 *
 * Swap protocol: the runner captures its continuation into a stack-local
 * `ret` (its address rides the per-thread `__nomen_fiber_ret` pointer) and
 * switches into `f->ctx`. A suspending fiber saves ITS continuation into
 * `f->ctx` (overwriting the entry state after the first suspension) and
 * switches into `__nomen_fiber_ret`. Resume therefore always continues where
 * the fiber last suspended.
 */

/**
 * Build a `.start()` / `.start_on(buf)` launch on a `Fiber(fn(args))`
 * construction (or a stored Fiber binding) — C backend
 * (CLOSURE.md Phase 3b). The receiver's fields carry the task
 * closure packed eagerly at the construction site, plus the result slot,
 * cancel flag, and future. This launches the closure on the fiber
 * scheduler (a heap stack, or the caller's fixed-size array buffer for
 * start_on — validated at check time, >= 16 KB), registers the future with
 * the enclosing nursery (if any), transfers the handles out of the
 * instance, and yields Task<T> (or nothing, fire-and-forget).
 */
export default function build_fiber_spawn_node(
	access_func: AccessFunctionCallNode,
	target: BaseNode,
	status: BuildStatus,
	start_on?: BaseNode,
) {
	// Emit pool + fiber infrastructure on first fiber spawn (file scope,
	// deduped; pool text first — the fiber text extends it).
	ensure_concurrency_runtime(status);
	status.used_fibers = true;

	const t_arg = spawn_result_type_arg(access_func.function_return_type);
	const mono_fiber = mono_type_name("Fiber", [t_arg]);
	const mono_task_name = mono_type_name("Task", [t_arg]);

	const nursery_id = status.nursery_stack?.at(-1);
	const fire_and_forget = !!access_func.is_statement;
	// A chained launch (`Fiber(fn(args)).start()`) consumes a TEMPORARY
	// instance — free it after transferring the handles; a stored binding's
	// instance is freed by its owner's scope exit.
	const target_is_temp =
		target.node_type === "func_call" &&
		!!((target as FunctionCallNode).is_thread_ctor || (target as FunctionCallNode).is_fiber_ctor);
	// The construction's own reference is consumed by the launch — the
	// pre-3b ref accounting (trampoline + Task [+ nursery]).
	const refs = fire_and_forget
		? nursery_id !== undefined
			? 2
			: 1
		: nursery_id !== undefined
			? 3
			: 2;

	// Statement expression: read the handles from the instance, launch the
	// fiber, optionally yield a Task.
	status.code += `({\n`;
	status.code += `\tstruct ${mono_fiber} *_self = `;
	build_node(target, status);
	status.code += `;\n`;
	status.code += `\tstruct nomen_future *_future = (struct nomen_future *)_self->future;\n`;
	status.code += `\tvoid *_result_ptr = (void *)_self->result_slot;\n`;
	status.code += `\tunsigned long long *_cancel_ptr = (unsigned long long *)_self->cancel_flag;\n`;
	status.code += `\tstruct nomen_closure *_closure = (struct nomen_closure *)_self->task;\n`;
	status.code += `\t_future->refs = ${refs};\n`;

	// Launch on a fiber stack. start_on's buffer was validated at check time
	// (fixed-size array, >= 16 KB); compute its byte size from the element
	// type (strings are the 16-byte fat pair, everything else is one word).
	status.code += `\t__nomen_fiber_spawn${start_on ? "_on" : ""}(_closure, _future`;
	if (start_on) {
		const buf_type = type_from_value_node(start_on);
		const elem_size = buf_type.name === "string" ? 16 : 8;
		const len_node = buf_type.length;
		const len =
			len_node && len_node.node_type === "value"
				? parseInt((len_node as unknown as { value: string }).value, 10)
				: NaN;
		const stack_bytes = Number.isNaN(len) ? 0 : len * elem_size;
		status.code += `, (void *)`;
		build_node(start_on, status);
		status.code += `, (size_t)${stack_bytes}`;
	}
	status.code += `);\n`;

	if (nursery_id !== undefined) {
		status.code += `\t__nomen_nursery_track((void **)&__nomen_nursery_${nursery_id}_futures, &__nomen_nursery_${nursery_id}_count, &__nomen_nursery_${nursery_id}_cap, _future);\n`;
	}
	// Transfer the handles out of the instance (started; #destroy no-ops).
	status.code += `\t_self->task = 0;\n`;
	status.code += `\t_self->future = 0;\n`;
	status.code += `\t_self->result_slot = 0;\n`;
	status.code += `\t_self->cancel_flag = 0;\n`;
	status.code += `\t_self->started = 1;\n`;
	if (target_is_temp) status.code += `\tfree(_self);\n`;
	if (fire_and_forget) {
		// Fire-and-forget: no Task handle needed. The fiber (and nursery,
		// if any) manage the future lifetime.
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
