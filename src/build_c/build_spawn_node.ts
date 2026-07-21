import SpawnNode from "../nodes/SpawnNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

/**
 * Pool infrastructure emitted as file-scope C on the first spawn.
 * Extracted from Task.#init so Task can be generic without duplicating
 * the pool per instantiation. Deduplicated by build_raw_node's
 * emitted_file_scope_blocks set (matched by content).
 */
const POOL_HEADER = `
#include <pthread.h>
#include <time.h>
static __thread unsigned long long *__echo_current_cancel_flag = NULL;
struct echo_future {
	pthread_mutex_t mu;
	pthread_cond_t cv;
	int done;
	int refs;
	unsigned long long *cancel_flag;
	void *result_slot;
};
static void __echo_future_wait(struct echo_future *f) {
	pthread_mutex_lock(&f->mu);
	while (!f->done) {
		if (__echo_current_cancel_flag && *__echo_current_cancel_flag) {
			pthread_mutex_unlock(&f->mu);
			return;
		}
		pthread_cond_wait(&f->cv, &f->mu);
	}
	pthread_mutex_unlock(&f->mu);
}
// Timed wait: returns 1 if the future completed, 0 if the deadline expired.
// deadline_ms == -1 means wait forever (same as __echo_future_wait).
static int __echo_future_timedwait(struct echo_future *f, long long deadline_ms) {
	pthread_mutex_lock(&f->mu);
	if (deadline_ms < 0) {
		while (!f->done) {
			if (__echo_current_cancel_flag && *__echo_current_cancel_flag) {
				pthread_mutex_unlock(&f->mu);
				return 0;
			}
			pthread_cond_wait(&f->cv, &f->mu);
		}
		pthread_mutex_unlock(&f->mu);
		return 1;
	}
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	long long now_ms = (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
	long long remaining = deadline_ms - now_ms;
	if (remaining < 0) remaining = 0;
	ts.tv_sec = (time_t)(remaining / 1000);
	ts.tv_nsec = (long)((remaining % 1000) * 1000000);
	while (!f->done) {
		if (__echo_current_cancel_flag && *__echo_current_cancel_flag) {
			pthread_mutex_unlock(&f->mu);
			return 0;
		}
		int rc = pthread_cond_timedwait(&f->cv, &f->mu, &ts);
		if (rc != 0) {
			// ETIMEDOUT — deadline expired
			pthread_mutex_unlock(&f->mu);
			return 0;
		}
	}
	pthread_mutex_unlock(&f->mu);
	return 1;
}
static void __echo_future_release(struct echo_future *f) {
	pthread_mutex_lock(&f->mu);
	int last = --f->refs == 0;
	pthread_mutex_unlock(&f->mu);
	if (last) {
		pthread_mutex_destroy(&f->mu);
		pthread_cond_destroy(&f->cv);
		free(f->cancel_flag);
		free(f->result_slot);
		free(f);
	}
}
struct echo_pool_task {
	void (*fn)(void *);
	void *arg;
	struct echo_pool_task *next;
};
static pthread_mutex_t __echo_pool_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t __echo_pool_cv = PTHREAD_COND_INITIALIZER;
static struct echo_pool_task *__echo_pool_head = NULL;
static struct echo_pool_task *__echo_pool_tail = NULL;
#define ECHO_POOL_DEFAULT_SIZE 4
#define ECHO_POOL_MAX_SIZE 64
static int __echo_pool_size = ECHO_POOL_DEFAULT_SIZE;
static pthread_t *__echo_pool_workers = NULL;
static int __echo_pool_nworkers = 0;
static int __echo_pool_busy = 0;
static int __echo_pool_init = 0;
static int __echo_pool_quitting = 0;
static void *__echo_pool_worker(void *arg) {
	(void)arg;
	while (1) {
		pthread_mutex_lock(&__echo_pool_mu);
		while (!__echo_pool_head && !__echo_pool_quitting) {
			pthread_cond_wait(&__echo_pool_cv, &__echo_pool_mu);
		}
		if (__echo_pool_quitting && !__echo_pool_head) {
			pthread_mutex_unlock(&__echo_pool_mu);
			return NULL;
		}
		struct echo_pool_task *t = __echo_pool_head;
		__echo_pool_head = t->next;
		if (!__echo_pool_head) __echo_pool_tail = NULL;
		__echo_pool_busy++;
		pthread_mutex_unlock(&__echo_pool_mu);
		t->fn(t->arg);
		free(t);
		pthread_mutex_lock(&__echo_pool_mu);
		__echo_pool_busy--;
		pthread_mutex_unlock(&__echo_pool_mu);
	}
	return NULL;
}
static void __echo_pool_shutdown(void) {
	if (!__echo_pool_init) return;
	pthread_mutex_lock(&__echo_pool_mu);
	__echo_pool_quitting = 1;
	pthread_cond_broadcast(&__echo_pool_cv);
	pthread_mutex_unlock(&__echo_pool_mu);
	for (int i = 0; i < __echo_pool_nworkers; i++) {
		pthread_join(__echo_pool_workers[i], NULL);
	}
	free(__echo_pool_workers);
	__echo_pool_workers = NULL;
	__echo_pool_nworkers = 0;
	__echo_pool_busy = 0;
	__echo_pool_init = 0;
	__echo_pool_quitting = 0;
}
static void __echo_pool_submit(void (*fn)(void *), void *arg) {
	if (!__echo_pool_init) {
		__echo_pool_init = 1;
		__echo_pool_workers = (pthread_t *)malloc(sizeof(pthread_t) * ECHO_POOL_MAX_SIZE);
		for (int i = 0; i < __echo_pool_size; i++) {
			pthread_create(&__echo_pool_workers[__echo_pool_nworkers], NULL, __echo_pool_worker, NULL);
			__echo_pool_nworkers++;
		}
		atexit(__echo_pool_shutdown);
	}
	struct echo_pool_task *t = (struct echo_pool_task *)malloc(sizeof(struct echo_pool_task));
	t->fn = fn;
	t->arg = arg;
	t->next = NULL;
	pthread_mutex_lock(&__echo_pool_mu);
	if (__echo_pool_busy >= __echo_pool_nworkers && __echo_pool_nworkers < ECHO_POOL_MAX_SIZE) {
		pthread_create(&__echo_pool_workers[__echo_pool_nworkers], NULL, __echo_pool_worker, NULL);
		__echo_pool_nworkers++;
	}
	if (__echo_pool_tail) {
		__echo_pool_tail->next = t;
	} else {
		__echo_pool_head = t;
	}
	__echo_pool_tail = t;
	pthread_cond_signal(&__echo_pool_cv);
	pthread_mutex_unlock(&__echo_pool_mu);
}
`;

/**
 * Build a `spawn <call>` node. Returns a Task value (via GCC statement
 * expression) so spawn can be used either as a statement (value discarded)
 * or as an expression (`let t = spawn fn(args)`).
 *
 * The Task's future is reference-counted and shared: the running trampoline
 * holds one ref, the returned Task holds one, and the enclosing nursery (if
 * any) holds one. Waiting is idempotent (join-once), so the returned handle
 * is fully usable both inside and outside a nursery — a nursery spawn can
 * be waited on explicitly and is still joined by the nursery at block exit.
 */
export default function build_spawn_node(node: SpawnNode, status: BuildStatus) {
	const call = node.call;
	const func_name = c_function_name(call.name);
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	// Emit pool infrastructure on first spawn (file scope, deduped).
	if (!status.headers.includes("__echo_pool_submit")) {
		status.headers += POOL_HEADER;
	}

	const struct_name = `__echo_spawn_${id}_args`;
	const tramp_name = `__echo_spawn_${id}_trampoline`;

	// Resolve each arg's C type. Classes/traits are pointers; primitives and
	// by-value structs use c_type's output directly. Generic instantiations
	// (e.g. Channel<uint64>) use the monomorphized C name (`Channel_uint64`).
	const arg_c_types: string[] = [];
	for (let i = 0; i < call.params.length; i++) {
		const arg_type = type_from_value_node(call.params[i]);
		const mono_name = arg_type.type_args?.length
			? `${arg_type.name}_${arg_type.type_args.map((t) => t.name).join("_")}`
			: arg_type.name;
		const is_class = !!status.structs.find((s) => s.name === mono_name && s.is_class);
		const is_trait = !!status.traits.find((t) => t.name === mono_name);
		arg_c_types.push(is_class || is_trait ? `struct ${mono_name} *` : c_type(mono_name));
	}

	// Emit the arg struct + trampoline to headers (file scope).
	// The args struct also carries a result slot pointer that the trampoline
	// writes the function's return value to (cast to uint64), a cancel flag
	// pointer that the trampoline publishes to a thread-local so the
	// spawned function can poll Task.current_cancelled(), and a future
	// pointer that the trampoline signals on completion.
	let header = `struct ${struct_name} {\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		header += `\t${arg_c_types[i]} arg${i};\n`;
	}
	header += `\tunsigned long long *result_slot;\n`;
	header += `\tunsigned long long *cancel_flag;\n`;
	header += `\tstruct echo_future *future;\n`;
	header += `};\n`;
	// Pool trampoline: signature is `void (*)(void*)` (no return). The pool
	// worker calls it; the trampoline calls the user function and signals
	// the future when done.
	header += `static void ${tramp_name}(void *p) {\n`;
	header += `\tstruct ${struct_name} *a = (struct ${struct_name} *)p;\n`;
	header += `\t__echo_current_cancel_flag = a->cancel_flag;\n`;
	// Determine if the function returns a value. We approximate by checking
	// the captured function_return_type — empty name means void/no return.
	const return_type_name = node.function_return_type?.name;
	const returns_value = !!(
		return_type_name &&
		return_type_name !== "void" &&
		return_type_name !== "?"
	);
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
	header += `\tpthread_mutex_lock(&a->future->mu);\n`;
	header += `\ta->future->done = 1;\n`;
	header += `\tpthread_cond_broadcast(&a->future->cv);\n`;
	header += `\tpthread_mutex_unlock(&a->future->mu);\n`;
	// The trampoline holds one future reference for the duration of the run —
	// release it only after signaling, so the future (and the result slot it
	// owns) is guaranteed alive while the result is written.
	header += `\t__echo_future_release(a->future);\n`;
	header += `\tfree(a);\n`;
	header += `}\n`;
	status.headers += header;

	// Resolve the monomorphized Task struct name for the allocation.
	// call.type is Task<T> — e.g. Task_uint64, Task<int>, etc.
	const task_type_args = call.type?.type_args;
	const mono_task_name = task_type_args?.length
		? `Task_${task_type_args.map((t) => t.name).join("_")}`
		: "Task";

	// Statement-expression that sets up the args, allocates the future,
	// submits to the pool, and yields a Task.
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
	status.code += `\tstruct echo_future *_future = (struct echo_future *)malloc(sizeof(struct echo_future));\n`;
	status.code += `\tpthread_mutex_init(&_future->mu, NULL);\n`;
	status.code += `\tpthread_cond_init(&_future->cv, NULL);\n`;
	status.code += `\t_future->done = 0;\n`;
	// The future owns the cancel flag and result slot.
	status.code += `\t_future->cancel_flag = _cancel_ptr;\n`;
	status.code += `\t_future->result_slot = _result_ptr;\n`;
	status.code += `\t_args->future = _future;\n`;

	// Inside a nursery: the nursery holds its own future reference (waits +
	// releases at block exit). Outside: only the trampoline and the returned
	// Task hold references. For fire-and-forget spawns (is_statement), no
	// Task is allocated — only the trampoline (and nursery, if any) hold refs.
	const nursery_id = status.nursery_stack?.at(-1);
	const fire_and_forget = !!node.is_statement;
	if (fire_and_forget) {
		status.code += `\t_future->refs = ${nursery_id !== undefined ? 2 : 1};\n`;
	} else {
		status.code += `\t_future->refs = ${nursery_id !== undefined ? 3 : 2};\n`;
	}
	status.code += `\t__echo_pool_submit(${tramp_name}, _args);\n`;
	if (nursery_id !== undefined) {
		status.code += `\t__echo_nursery_${nursery_id}_futures[__echo_nursery_${nursery_id}_count++] = (unsigned long long)_future;\n`;
	}
	if (fire_and_forget) {
		// Fire-and-forget: no Task handle needed. The trampoline (and nursery,
		// if any) manage the future lifetime. Yield 0 (discarded value).
		status.code += `\t(void)0;\n`;
	} else {
		// Task is a class (heap-allocated). Construct via malloc + field assigns
		// and yield the pointer. The handle is fully usable whether or not a
		// nursery also tracks the future (join-once semantics).
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
