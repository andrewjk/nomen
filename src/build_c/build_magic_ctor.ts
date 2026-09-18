import emission_label from "../build_common/emission_label.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import build_node from "./build_node.ts";
import { ensure_concurrency_runtime, spawn_arg_c_types } from "./build_spawn_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";

/**
 * The compiler-special `Thread(fn(args))` / `Fiber(fn(args))` constructor
 * (docs/CLOSURE_PLAN.md Phase 3b): the construction packs the wrapped call's
 * arguments EAGERLY into a task environment, allocates the result slot,
 * cancel flag, and future, and builds the task closure — a heap descriptor
 * over that environment (the same ABI every lambda lowers to; the runtime's
 * submit/fiber/detach seams all speak it since Phase 3a). The expression
 * yields a heap `Thread<T>` / `Fiber<T>` instance carrying the handles — a
 * real, storable value whose `#destroy` enforces must-start. The launch
 * (`.start()` / `.detach()` / `.start_on(buf)` / a nursery's `.start(...)`)
 * submits the packed closure and transfers the handles out of the instance.
 */

/** The trampoline/descriptor C types for one spawn site. */
export interface SpawnTaskC {
	returns_value: boolean;
	c_ret_type: string;
	slot_c_type: string;
}

/** Resolve the trampoline's return/result-slot C types from the wrapped
 *  call's return type (the same rules every spawn emitter used pre-3b). */
export function spawn_task_c_types(
	function_return_type: { name?: string } | undefined,
	status: BuildStatus,
): SpawnTaskC {
	const return_type_name = function_return_type?.name;
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
			: c_type(return_type_name!);
	// The result slot carries the full return VALUE — a fat `string` result is
	// a 16-byte nomen_string, so the cell is typed (and sized) as the return
	// type, not a fixed unsigned long long (which truncated the len half).
	const slot_c_type = returns_value ? c_ret_type : "unsigned long long";
	return { returns_value, c_ret_type, slot_c_type };
}

/**
 * Emit (headers, file scope) the per-site task body for a wrapped call:
 * the env struct (packed args + result slot + cancel flag + future), the
 * closure-body trampoline (`void (*)(struct nomen_closure *)` — the code
 * receives the closure itself and reaches the env through it), and the
 * site's static descriptor template. Shared by Thread and Fiber
 * constructions.
 */
export function emit_spawn_task_body(
	call: FunctionCallNode,
	status: BuildStatus,
	id: number,
	task_c: SpawnTaskC,
): { struct_name: string; desc_name: string; arg_c_types: string[]; func_name: string } {
	const func_name = c_function_name(emission_label(call.resolved_function ?? call));
	const struct_name = `__nomen_spawn_${id}_args`;
	const tramp_name = `__nomen_spawn_${id}_trampoline`;
	const desc_name = `__nomen_spawn_${id}_descriptor`;
	const arg_c_types = spawn_arg_c_types(call, status);
	const { returns_value, c_ret_type, slot_c_type } = task_c;

	// Forward-declare the wrapped function before the trampoline. The
	// trampoline is a full function definition appended to the headers, and
	// it may be appended BEFORE the function's own prototype lands there —
	// struct methods are built before free functions, so a spawn inside a
	// method (e.g. a monomorphized generic body) emits its trampoline ahead
	// of any free function declared after the generic struct. A compatible
	// redeclaration is legal C, so emitting this unconditionally is safe.
	let header = `${c_ret_type} ${func_name}(${arg_c_types.join(", ")});\n`;

	header += `struct ${struct_name} {\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		header += `\t${arg_c_types[i]} arg${i};\n`;
	}
	header += `\t${slot_c_type} *result_slot;\n`;
	header += `\tunsigned long long *cancel_flag;\n`;
	header += `\tstruct nomen_future *future;\n`;
	header += `};\n`;
	// Trampoline: signature is the closure ABI — the code receives the
	// closure itself, and the args struct rides in `env`. The pool worker
	// (or fiber scheduler) calls it; the trampoline calls the user function
	// and signals the future when done. The closure itself is disposed by
	// the future's last release (owner_args), not here.
	header += `static void ${tramp_name}(struct nomen_closure *_c) {\n`;
	header += `\tstruct ${struct_name} *a = (struct ${struct_name} *)_c->env;\n`;
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
	// release it only after signaling, so the future (and the result slot it
	// owns) is guaranteed alive while the result is written. The final
	// release disposes the task closure (env + descriptor).
	header += `\t__nomen_future_release(a->future);\n`;
	header += `}\n`;
	// Static descriptor template for this site: every construction copies it
	// into a heap descriptor (owned = 1) carrying the per-construction env.
	header += `static struct nomen_closure ${desc_name} = { (void *)${tramp_name}, NULL, 0, NULL };\n`;
	status.headers += header;

	return { struct_name, desc_name, arg_c_types, func_name };
}

/**
 * Build the `Thread(fn(args))` / `Fiber(fn(args))` construction expression:
 * a GCC statement expression that packs the args, allocates the machinery,
 * constructs the task closure, and yields the heap instance.
 */
export default function build_magic_ctor_node(node: FunctionCallNode, status: BuildStatus) {
	const kind = node.is_fiber_ctor ? "Fiber" : "Thread";
	const call = node.params[0] as FunctionCallNode;
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	// Emit pool infrastructure on first spawn (file scope, deduped).
	ensure_concurrency_runtime(status);

	const task_c = spawn_task_c_types(node.function_return_type, status);
	const { struct_name, desc_name } = emit_spawn_task_body(call, status, id, task_c);
	const { returns_value, slot_c_type } = task_c;
	const mono_name = mono_type_name(kind, node.type?.type_args);

	// Statement expression: pack args, allocate slot/flag/future, build the
	// task closure, construct the instance.
	status.code += `({\n`;
	status.code += `\tstruct ${struct_name} *_args = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	for (let i = 0; i < call.params.length; i++) {
		status.code += `\t_args->arg${i} = `;
		build_node(call.params[i], status);
		status.code += ";\n";
	}
	if (returns_value) {
		status.code += `\t${slot_c_type} *_result_ptr = (${slot_c_type} *)malloc(sizeof(${slot_c_type}));\n`;
		status.code += `\tmemset(_result_ptr, 0, sizeof(${slot_c_type}));\n`;
	} else {
		// A void task's slot still exists (16 bytes — Task.result may read
		// the pair) but is never written.
		status.code += `\tunsigned long long *_result_ptr = (unsigned long long *)malloc(16);\n`;
		status.code += `\tmemset(_result_ptr, 0, 16);\n`;
	}
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
	status.code += `\t_future->fiber_waiters = NULL;\n`;
	status.code += `\t_future->owning_fiber = NULL;\n`;
	// One reference: this instance. The launch (or #destroy) releases it.
	status.code += `\t_future->refs = 1;\n`;
	status.code += `\t_args->future = _future;\n`;
	status.code += `\tstruct nomen_closure *_closure = (struct nomen_closure *)malloc(sizeof(struct nomen_closure));\n`;
	status.code += `\t*_closure = ${desc_name};\n`;
	status.code += `\t_closure->env = _args;\n`;
	status.code += `\t_closure->owned = 1;\n`;
	status.code += `\t_future->owner_args = _closure;\n`;
	// The instance: zeroed first (a class's trait-table slot stays NULL
	// unless trait-dispatched — the same posture as the spawn-built Task),
	// then the handles.
	status.code += `\tstruct ${mono_name} *_self = (struct ${mono_name} *)malloc(sizeof(struct ${mono_name}));\n`;
	status.code += `\tmemset(_self, 0, sizeof(struct ${mono_name}));\n`;
	status.code += `\t_self->task = (unsigned long long)_closure;\n`;
	status.code += `\t_self->result_slot = (unsigned long long)_result_ptr;\n`;
	status.code += `\t_self->cancel_flag = (unsigned long long)_cancel_ptr;\n`;
	status.code += `\t_self->future = (unsigned long long)_future;\n`;
	status.code += `\t_self->started = 0;\n`;
	status.code += `\t_self;\n`;
	status.code += `})\n`;
}
