import { mono_type_name } from "../build_common/mono_name.ts";
import { is_built_in_type } from "../built_in_types.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
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
export const POOL_HEADER = `
#include <pthread.h>
#include <time.h>
static __thread unsigned long long *__nomen_current_cancel_flag = NULL;
struct nomen_future {
	pthread_mutex_t mu;
	pthread_cond_t cv;
	int done;
	int refs;
	unsigned long long *cancel_flag;
	void *result_slot;
	void *owner_args;
};
static void __nomen_future_wait(struct nomen_future *f) {
	pthread_mutex_lock(&f->mu);
	while (!f->done) {
		if (__nomen_current_cancel_flag && *__nomen_current_cancel_flag) {
			pthread_mutex_unlock(&f->mu);
			return;
		}
		pthread_cond_wait(&f->cv, &f->mu);
	}
	pthread_mutex_unlock(&f->mu);
}
// Timed wait: returns 1 if the future completed, 0 if the deadline expired.
// deadline_ms == -1 means wait forever (same as __nomen_future_wait).
static int __nomen_future_timedwait(struct nomen_future *f, long long deadline_ms) {
	pthread_mutex_lock(&f->mu);
	if (deadline_ms < 0) {
		while (!f->done) {
			if (__nomen_current_cancel_flag && *__nomen_current_cancel_flag) {
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
		if (__nomen_current_cancel_flag && *__nomen_current_cancel_flag) {
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
static void __nomen_future_release(struct nomen_future *f) {
	pthread_mutex_lock(&f->mu);
	int last = --f->refs == 0;
	pthread_mutex_unlock(&f->mu);
	if (last) {
		pthread_mutex_destroy(&f->mu);
		pthread_cond_destroy(&f->cv);
		free(f->cancel_flag);
		free(f->result_slot);
		// The spawn args struct is owned by the future: freeing it here (the
		// last release, ordered after every use — trampoline, Task destroy,
		// nursery join) instead of inside the trampoline avoids the worker's
		// free racing the submitting thread's post-submit allocations, which
		// corrupted the freshly-allocated Task on macOS's nano allocator
		// (intermittent SIGSEGV in Task.result).
		if (f->owner_args) free(f->owner_args);
		free(f);
	}
}
struct nomen_pool_task {
	void (*fn)(void *);
	void *arg;
	struct nomen_pool_task *next;
};
static pthread_mutex_t __nomen_pool_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t __nomen_pool_cv = PTHREAD_COND_INITIALIZER;
static struct nomen_pool_task *__nomen_pool_head = NULL;
static struct nomen_pool_task *__nomen_pool_tail = NULL;
#define ECHO_POOL_DEFAULT_SIZE 4
#define ECHO_POOL_MAX_SIZE 64
static int __nomen_pool_size = ECHO_POOL_DEFAULT_SIZE;
static pthread_t *__nomen_pool_workers = NULL;
static int __nomen_pool_nworkers = 0;
static int __nomen_pool_busy = 0;
static int __nomen_pool_init = 0;
static int __nomen_pool_quitting = 0;
static void *__nomen_pool_worker(void *arg) {
	(void)arg;
	while (1) {
		pthread_mutex_lock(&__nomen_pool_mu);
		while (!__nomen_pool_head && !__nomen_pool_quitting) {
			pthread_cond_wait(&__nomen_pool_cv, &__nomen_pool_mu);
		}
		if (__nomen_pool_quitting && !__nomen_pool_head) {
			pthread_mutex_unlock(&__nomen_pool_mu);
			return NULL;
		}
		struct nomen_pool_task *t = __nomen_pool_head;
		__nomen_pool_head = t->next;
		if (!__nomen_pool_head) __nomen_pool_tail = NULL;
		__nomen_pool_busy++;
		pthread_mutex_unlock(&__nomen_pool_mu);
		t->fn(t->arg);
		free(t);
		pthread_mutex_lock(&__nomen_pool_mu);
		__nomen_pool_busy--;
		pthread_mutex_unlock(&__nomen_pool_mu);
	}
	return NULL;
}
static void __nomen_pool_shutdown(void) {
	if (!__nomen_pool_init) return;
	pthread_mutex_lock(&__nomen_pool_mu);
	__nomen_pool_quitting = 1;
	pthread_cond_broadcast(&__nomen_pool_cv);
	pthread_mutex_unlock(&__nomen_pool_mu);
	for (int i = 0; i < __nomen_pool_nworkers; i++) {
		pthread_join(__nomen_pool_workers[i], NULL);
	}
	free(__nomen_pool_workers);
	__nomen_pool_workers = NULL;
	__nomen_pool_nworkers = 0;
	__nomen_pool_busy = 0;
	__nomen_pool_init = 0;
	__nomen_pool_quitting = 0;
}
static void __nomen_pool_submit(void (*fn)(void *), void *arg) {
	if (!__nomen_pool_init) {
		__nomen_pool_init = 1;
		__nomen_pool_workers = (pthread_t *)malloc(sizeof(pthread_t) * ECHO_POOL_MAX_SIZE);
		for (int i = 0; i < __nomen_pool_size; i++) {
			pthread_create(&__nomen_pool_workers[__nomen_pool_nworkers], NULL, __nomen_pool_worker, NULL);
			__nomen_pool_nworkers++;
		}
		atexit(__nomen_pool_shutdown);
	}
	struct nomen_pool_task *t = (struct nomen_pool_task *)malloc(sizeof(struct nomen_pool_task));
	t->fn = fn;
	t->arg = arg;
	t->next = NULL;
	pthread_mutex_lock(&__nomen_pool_mu);
	if (__nomen_pool_busy >= __nomen_pool_nworkers && __nomen_pool_nworkers < ECHO_POOL_MAX_SIZE) {
		pthread_create(&__nomen_pool_workers[__nomen_pool_nworkers], NULL, __nomen_pool_worker, NULL);
		__nomen_pool_nworkers++;
	}
	if (__nomen_pool_tail) {
		__nomen_pool_tail->next = t;
	} else {
		__nomen_pool_head = t;
	}
	__nomen_pool_tail = t;
	pthread_cond_signal(&__nomen_pool_cv);
	pthread_mutex_unlock(&__nomen_pool_mu);
}
// Race-mode helpers: used by async(mode: race) to wait until any one future
// in a nursery completes (or the deadline expires). Returns 1 if any future
// is done, 0 if the deadline hit. Polls every 1ms — the latency/cost
// tradeoff favors simplicity over a signaling mechanism.
static void __nomen_future_cancel(struct nomen_future *f) {
	if (f->cancel_flag) *(f->cancel_flag) = 1;
}
static int __nomen_future_is_done(struct nomen_future *f) {
	pthread_mutex_lock(&f->mu);
	int d = f->done;
	pthread_mutex_unlock(&f->mu);
	return d;
}
static int __nomen_nursery_race_wait(struct nomen_future **futures, int count, long long deadline_ms) {
	if (count <= 0) return 0;
	struct timespec sleep_ts = {0, 1000000}; // 1ms
	while (1) {
		for (int i = 0; i < count; i++) {
			if (__nomen_future_is_done(futures[i])) return 1;
		}
		if (deadline_ms > 0) {
			struct timespec ts;
			clock_gettime(CLOCK_REALTIME, &ts);
			long long now_ms = (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
			if (now_ms >= deadline_ms) return 0;
		}
		nanosleep(&sleep_ts, NULL);
	}
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
	if (!status.headers.includes("__nomen_pool_submit")) {
		status.headers += POOL_HEADER;
	}

	const struct_name = `__nomen_spawn_${id}_args`;
	const tramp_name = `__nomen_spawn_${id}_trampoline`;

	const arg_c_types = spawn_arg_c_types(call, status);

	// Determine if the function returns a value. We approximate by checking
	// the captured function_return_type — empty name means void/no return.
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
	// The result slot carries the full return VALUE — a fat `string` result is
	// a 16-byte nomen_string, so the cell is typed (and sized) as the return
	// type, not a fixed unsigned long long (which truncated the len half).
	const slot_c_type = returns_value ? c_ret_type : "unsigned long long";

	// Forward-declare the spawned function before the trampoline. The
	// trampoline is a full function definition appended to the headers, and
	// it may be appended BEFORE the function's own prototype lands there —
	// struct methods are built before free functions, so a spawn inside a
	// method (e.g. a monomorphized generic body) emits its trampoline ahead
	// of any free function declared after the generic struct. A compatible
	// redeclaration is legal C, so emitting this unconditionally is safe.
	// Mirrors the aarch64 companion's trampoline declaration.
	let header = `${c_ret_type} ${func_name}(${arg_c_types.join(", ")});\n`;

	// Emit the arg struct + trampoline to headers (file scope).
	// The args struct also carries a result slot pointer that the trampoline
	// writes the function's return value to (cast to uint64), a cancel flag
	// pointer that the trampoline publishes to a thread-local so the
	// spawned function can poll Task.current_cancelled(), and a future
	// pointer that the trampoline signals on completion.
	header += `struct ${struct_name} {\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		header += `\t${arg_c_types[i]} arg${i};\n`;
	}
	header += `\t${slot_c_type} *result_slot;\n`;
	header += `\tunsigned long long *cancel_flag;\n`;
	header += `\tstruct nomen_future *future;\n`;
	header += `};\n`;
	// Pool trampoline: signature is `void (*)(void*)` (no return). The pool
	// worker calls it; the trampoline calls the user function and signals
	// the future when done.
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
	header += `\tpthread_mutex_lock(&a->future->mu);\n`;
	header += `\ta->future->done = 1;\n`;
	header += `\tpthread_cond_broadcast(&a->future->cv);\n`;
	header += `\tpthread_mutex_unlock(&a->future->mu);\n`;
	// The trampoline holds one future reference for the duration of the run —
	// release it only after signaling, so the future (and the result slot it
	// owns) is guaranteed alive while the result is written.
	header += `\t__nomen_future_release(a->future);\n`; // a freed via f->owner_args at last release
	header += `}\n`;
	status.headers += header;

	// Resolve the monomorphized Task struct name for the allocation.
	// call.type is Task<T> — e.g. Task_uint64, Task<int>, etc.
	const task_type_args = call.type?.type_args;
	const mono_task_name = mono_type_name("Task", task_type_args);

	// Statement-expression that sets up the args, allocates the future,
	// submits to the pool, and yields a Task.
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
	// The future owns the cancel flag and result slot.
	status.code += `\t_future->cancel_flag = _cancel_ptr;\n`;
	status.code += `\t_future->result_slot = _result_ptr;\n`;
	status.code += `\t_args->future = _future;\n`;
	status.code += `\t_future->owner_args = _args;\n`;

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
	status.code += `\t__nomen_pool_submit(${tramp_name}, _args);\n`;
	if (nursery_id !== undefined) {
		status.code += `\t__nomen_nursery_${nursery_id}_futures[__nomen_nursery_${nursery_id}_count++] = (unsigned long long)_future;\n`;
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

/**
 * Resolve each spawn argument's C type. Classes/traits are pointers;
 * primitives and by-value structs use c_type's output directly. Generic
 * instantiations (e.g. Channel<uint64>) use the monomorphized C name
 * (`Channel_uint64`). The type comes from the CALLEE's declared parameter
 * whenever it can be resolved — an argument's own node type can differ
 * (e.g. an int literal `41` passed for a `uint64` param lowers to `long`,
 * conflicting with the emitted `unsigned long long` prototype). Falls back
 * to the argument's type when the callee (or its param type) can't be
 * resolved at build time.
 */
export function spawn_arg_c_types(call: FunctionCallNode, status: BuildStatus): string[] {
	const arg_c_types: string[] = [];
	const callee = find_spawn_callee(call.name, status);
	const callee_params = callee?.params?.filter((p) => !p.is_self_param) ?? [];
	for (let i = 0; i < call.params.length; i++) {
		// Use the callee's declared param type only when it lowers to a real
		// C type (builtin or a known struct/enum); an unresolved generic type
		// param (`T`) on a non-monomorphized body falls back to the arg type.
		const param_type =
			callee_params[i]?.type && is_resolvable_c_type(callee_params[i].type!, status)
				? callee_params[i].type!
				: type_from_value_node(call.params[i]);
		const mono_name = mono_type_name(param_type);
		const is_class = !!status.structs.find((s) => s.name === mono_name && s.is_class);
		const is_trait = !!status.traits.find((t) => t.name === mono_name);
		arg_c_types.push(is_class || is_trait ? `struct ${mono_name} *` : c_type(mono_name));
	}
	return arg_c_types;
}

/** Whether a Nomen type name lowers to a real C type in this build: a
 *  builtin primitive (or the pseudo-types void/null), or a struct/enum the
 *  backend knows (post-monomorphization). Unresolved generic type params
 *  (`T`) fail this check. */
function is_resolvable_c_type(type: { name: string }, status: BuildStatus): boolean {
	if (is_built_in_type(type.name) || type.name === "void" || type.name === "null") return true;
	return !!status.structs.find((s) => s.name === type.name);
}

/**
 * Find the spawned function's definition — a top-level function, a function
 * nested in a block (parse wrappers hoist user code into `main`), or a
 * struct/trait method (matched by its mangled `Struct_method` name) — so the
 * trampoline's forward declaration can copy the callee's DECLARED parameter
 * types. Monomorphized clones are also reachable this way (they are appended
 * to the AST). A same-named pair would already collide at C level, so the
 * first match is as good as any.
 */
function find_spawn_callee(name: string, status: BuildStatus): FunctionNode | undefined {
	let found: FunctionNode | undefined;
	const visit = (node: BaseNode | undefined | null): void => {
		if (found || !node || typeof node !== "object") return;
		if (node.node_type === "func") {
			if ((node as FunctionNode).name === name) {
				found = node as FunctionNode;
				return;
			}
		} else if (node.node_type === "struct" || node.node_type === "trait") {
			const functions = (node as unknown as { functions?: FunctionNode[] }).functions ?? [];
			for (const func of functions) {
				const owner = (node as unknown as { name: string }).name;
				if (func.name === name || `${owner}_${func.name}` === name) {
					found = func;
					return;
				}
			}
		}
		for (const key of Object.keys(node as unknown as Record<string, unknown>)) {
			if (key === "parent" || key === "scope") continue;
			const v = (node as unknown as Record<string, unknown>)[key];
			if (Array.isArray(v)) {
				for (const item of v) visit(item as BaseNode);
			} else if (v && typeof v === "object" && "node_type" in v) {
				visit(v as BaseNode);
			}
			if (found) return;
		}
	};
	visit(status.root);
	return found;
}
