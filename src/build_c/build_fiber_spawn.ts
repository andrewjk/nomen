import emission_label from "../build_common/emission_label.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import SpawnNode from "../nodes/SpawnNode.ts";
import build_node from "./build_node.ts";
import { ensure_concurrency_runtime, spawn_arg_c_types } from "./build_spawn_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

/**
 * Fiber scheduler runtime (ASYNC_PLAN.md Phase 1), C backend.
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
 * Build a `Fiber(fn(args)).start()` / `.start_on(buf)` node (C backend).
 *
 * The arg struct, result slot, cancel flag, and future are identical to the
 * Thread path (build_spawn_node) — the Task<T> handle machinery is shared.
 * The only difference is the launch step: the per-site trampoline runs on a
 * fiber stack under the fiber scheduler instead of being submitted to the
 * thread pool. `future` is passed to the spawn helper for signature
 * symmetry with the aarch64 backend; lifetime stays with the future's
 * refcount.
 */
export default function build_fiber_spawn_node(
	node: SpawnNode,
	status: BuildStatus,
	start_on?: BaseNode,
) {
	const call = node.call;
	const func_name = c_function_name(emission_label(call.resolved_function ?? call));
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	// Emit pool + fiber infrastructure on first fiber spawn (file scope,
	// deduped; pool text first — the fiber text extends it).
	ensure_concurrency_runtime(status);
	status.used_fibers = true;

	const struct_name = `__nomen_spawn_${id}_args`;
	const tramp_name = `__nomen_spawn_${id}_trampoline`;

	const arg_c_types = spawn_arg_c_types(call, status);

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
	const slot_c_type = returns_value ? c_ret_type : "unsigned long long";

	let header = `${c_ret_type} ${func_name}(${arg_c_types.join(", ")});\n`;
	header += `struct ${struct_name} {\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		header += `\t${arg_c_types[i]} arg${i};\n`;
	}
	header += `\t${slot_c_type} *result_slot;\n`;
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
		header += `\t*(a->result_slot) = _r;\n`;
	}
	header += `\t__nomen_current_cancel_flag = NULL;\n`;
	header += `\t__nomen_future_complete(a->future);\n`;
	// The trampoline holds one future reference for the duration of the run —
	// release it only after signaling. The fiber itself is freed by the
	// scheduler when the resumer observes DONE.
	header += `\t__nomen_future_release(a->future);\n`;
	header += `}\n`;
	status.headers += header;

	const task_type_args = call.type?.type_args;
	const mono_task_name = mono_type_name("Task", task_type_args);

	// Statement-expression: set up args, allocate the future, launch the
	// fiber, optionally yield a Task. Identical to build_spawn_node except
	// the launch step.
	status.code += `({\n`;
	status.code += `\tstruct ${struct_name} *_args = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	for (let i = 0; i < call.params.length; i++) {
		status.code += `\t_args->arg${i} = `;
		build_node(call.params[i], status);
		status.code += ";\n";
	}
	status.code += `\t${slot_c_type} *_result_ptr = (${slot_c_type} *)malloc(sizeof(${slot_c_type}));\n`;
	status.code += `\tmemset(_result_ptr, 0, sizeof(${slot_c_type}));\n`;
	status.code += `\t_args->result_slot = _result_ptr;\n`;
	status.code += `\tunsigned long long *_cancel_ptr = (unsigned long long *)malloc(sizeof(unsigned long long));\n`;
	status.code += `\t*_cancel_ptr = 0;\n`;
	status.code += `\t_args->cancel_flag = _cancel_ptr;\n`;
	status.code += `\tstruct nomen_future *_future = (struct nomen_future *)malloc(sizeof(struct nomen_future));\n`;
	status.code += `\tpthread_mutex_init(&_future->mu, NULL);\n`;
	status.code += `\tpthread_cond_init(&_future->cv, NULL);\n`;
	status.code += `\t_future->done = 0;\n`;
	status.code += `\t_future->fiber_waiters = NULL;\n`;
	status.code += `\t_future->owning_fiber = NULL;\n`;
	status.code += `\t_future->cancel_flag = _cancel_ptr;\n`;
	status.code += `\t_future->result_slot = _result_ptr;\n`;
	status.code += `\t_args->future = _future;\n`;
	status.code += `\t_future->owner_args = _args;\n`;

	// Future refs: trampoline + returned Task (+ nursery). Fire-and-forget
	// drops the Task reference.
	const nursery_id = status.nursery_stack?.at(-1);
	const fire_and_forget = !!node.is_statement;
	if (fire_and_forget) {
		status.code += `\t_future->refs = ${nursery_id !== undefined ? 2 : 1};\n`;
	} else {
		status.code += `\t_future->refs = ${nursery_id !== undefined ? 3 : 2};\n`;
	}

	// Launch on a fiber stack. start_on's buffer was validated at check time
	// (fixed-size array, >= 16 KB); compute its byte size from the element
	// type (strings are the 16-byte fat pair, everything else is one word).
	status.code += `\t__nomen_fiber_spawn${start_on ? "_on" : ""}(${tramp_name}, _args, _future`;
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
		status.code += `\t__nomen_nursery_${nursery_id}_futures[__nomen_nursery_${nursery_id}_count++] = _future;\n`;
	}
	if (fire_and_forget) {
		// Fire-and-forget: no Task handle needed. The trampoline (and
		// nursery, if any) manage the future lifetime.
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
