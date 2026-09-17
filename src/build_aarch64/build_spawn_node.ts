import type BuildStatus from "../build_c/BuildStatus.ts";
import c_function_name from "../build_c/utils/c_function_name.ts";
import c_type from "../build_c/utils/c_type.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import emission_label from "../build_common/emission_label.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import SpawnNode from "../nodes/SpawnNode.ts";
import build_node from "./build_node.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";

/**
 * Pool infrastructure emitted as file-scope C on the first spawn.
 * Same as the C backend's POOL_HEADER — compiled as C in the companion file
 * and linked with the aarch64 assembly output.
 */
export const POOL_HEADER_C = `
#include <pthread.h>
#include <time.h>
static __thread unsigned long long *__nomen_current_cancel_flag = NULL;
// Fiber runtime (ASYNC_PLAN.md Phase 1). The pool and the fiber scheduler
// share one companion text: this block owns the future machinery and
// declares the fiber seam; FIBER_HEADER_C (appended immediately after)
// defines it. A worker drains runnable fibers between pool tasks, so a
// parked fiber frees its worker instead of blocking it. The switch
// primitive is a naked-asm function in FIBER_HEADER_C — no ucontext. Only
// pointers to struct nomen_fiber appear here; the full type lives in
// FIBER_HEADER_C.
struct nomen_fiber;
static __thread struct nomen_fiber *__nomen_current_fiber = NULL;
static struct nomen_fiber *__nomen_fiber_try_pop(void);
static int __nomen_fiber_pending(void);
static void __nomen_fiber_run_here(struct nomen_fiber *f);
struct nomen_future {
	pthread_mutex_t mu;
	pthread_cond_t cv;
	int done;
	int refs;
	unsigned long long *cancel_flag;
	void *result_slot;
	void *owner_args;
	// Fibers parked waiting for this future (singly-linked via ->next).
	// Woken by __nomen_future_complete. NULL when no fiber ever waited.
	struct nomen_fiber *fiber_waiters;
	// The fiber whose task this future is (set at fiber spawn). Cancellation
	// uses it to wake a fiber parked on a primitive waitq.
	struct nomen_fiber *owning_fiber;
};
// Fiber seam (defined in FIBER_HEADER_C, appended after this block).
// Declared here — after struct nomen_future is complete — so the
// prototypes bind to the file-scope type.
static void __nomen_fiber_schedule(struct nomen_fiber *f);
static void __nomen_fiber_park_on_future(struct nomen_future *f);
static void __nomen_fiber_wake_waiters(struct nomen_fiber *w);
static void __nomen_fiber_coop_drain(void);
// Tentative; the fiber header defines it with an initializer.
static int __nomen_fiber_coop;
static void __nomen_pool_ensure(void);
void __nomen_future_wait(struct nomen_future *f) {
	// Inside a fiber: park the fiber instead of blocking the worker thread.
	// Park-before-signal (under the future's mutex) — see the C backend.
	if (__nomen_current_fiber) {
		__nomen_fiber_park_on_future(f);
		return;
	}
	// Cooperative mode: no worker threads exist, so pending fibers are the
	// only code that can complete this future — run them before blocking.
	if (__nomen_fiber_coop) __nomen_fiber_coop_drain();
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
// Mark the future done and wake every fiber parked on it. Called by the
// generated trampolines instead of the inline done-signaling sequence, so
// fiber waiters rejoin the scheduler. The waiter list walk lives in
// FIBER_HEADER_C (full nomen_fiber type).
static void __nomen_future_complete(struct nomen_future *f) {
	pthread_mutex_lock(&f->mu);
	f->done = 1;
	struct nomen_fiber *w = f->fiber_waiters;
	f->fiber_waiters = NULL;
	pthread_cond_broadcast(&f->cv);
	pthread_mutex_unlock(&f->mu);
	if (w) __nomen_fiber_wake_waiters(w);
}
int __nomen_future_timedwait(struct nomen_future *f, long long deadline_ms) {
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
	// pthread_cond_timedwait wants an ABSOLUTE CLOCK_REALTIME deadline;
	// deadline_ms already is one (the generated code builds now + timeout).
	struct timespec ts;
	ts.tv_sec = (time_t)(deadline_ms / 1000);
	ts.tv_nsec = (long)((deadline_ms % 1000) * 1000000);
	while (!f->done) {
		if (__nomen_current_cancel_flag && *__nomen_current_cancel_flag) {
			pthread_mutex_unlock(&f->mu);
			return 0;
		}
		int rc = pthread_cond_timedwait(&f->cv, &f->mu, &ts);
		if (rc != 0) {
			pthread_mutex_unlock(&f->mu);
			return 0;
		}
	}
	pthread_mutex_unlock(&f->mu);
	return 1;
}
void __nomen_future_release(struct nomen_future *f) {
	pthread_mutex_lock(&f->mu);
	int last = --f->refs == 0;
	pthread_mutex_unlock(&f->mu);
	if (last) {
		pthread_mutex_destroy(&f->mu);
		pthread_cond_destroy(&f->cv);
		free(f->cancel_flag);
		free(f->result_slot);
		if (f->owner_args) free(f->owner_args);
		free(f);
	}
}
struct nomen_pool_task {
	void (*fn)(void *);
	void *arg;
	struct nomen_pool_task *next;
};
pthread_mutex_t __nomen_pool_mu = PTHREAD_MUTEX_INITIALIZER;
pthread_cond_t __nomen_pool_cv = PTHREAD_COND_INITIALIZER;
struct nomen_pool_task *__nomen_pool_head = NULL;
struct nomen_pool_task *__nomen_pool_tail = NULL;
#define ECHO_POOL_DEFAULT_SIZE 4
#define ECHO_POOL_MAX_SIZE 64
int __nomen_pool_size = ECHO_POOL_DEFAULT_SIZE;
pthread_t *__nomen_pool_workers = NULL;
int __nomen_pool_nworkers = 0;
int __nomen_pool_busy = 0;
int __nomen_pool_init = 0;
int __nomen_pool_quitting = 0;
static void *__nomen_pool_worker(void *arg) {
	(void)arg;
	while (1) {
		// Fibers first: a runnable fiber means some task parked or a fiber
		// was spawned; running it here keeps workers busy instead of idle.
		struct nomen_fiber *fiber = __nomen_fiber_try_pop();
		if (fiber) {
			__nomen_fiber_run_here(fiber);
			continue;
		}
		pthread_mutex_lock(&__nomen_pool_mu);
		while (!__nomen_pool_head && !__nomen_fiber_pending() && !__nomen_pool_quitting) {
			pthread_cond_wait(&__nomen_pool_cv, &__nomen_pool_mu);
		}
		if (__nomen_pool_quitting && !__nomen_pool_head) {
			pthread_mutex_unlock(&__nomen_pool_mu);
			return NULL;
		}
		if (!__nomen_pool_head) {
			// A fiber was queued while we waited — loop and run it.
			pthread_mutex_unlock(&__nomen_pool_mu);
			continue;
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
void __nomen_pool_shutdown(void) {
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
void __nomen_pool_ensure(void) {
	if (__nomen_pool_init) return;
	__nomen_pool_init = 1;
	__nomen_pool_workers = (pthread_t *)malloc(sizeof(pthread_t) * ECHO_POOL_MAX_SIZE);
	for (int i = 0; i < __nomen_pool_size; i++) {
		pthread_create(&__nomen_pool_workers[__nomen_pool_nworkers], NULL, __nomen_pool_worker, NULL);
		__nomen_pool_nworkers++;
	}
	atexit(__nomen_pool_shutdown);
}
void __nomen_pool_submit(void (*fn)(void *), void *arg) {
	__nomen_pool_ensure();
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
void __nomen_future_cancel(struct nomen_future *f) {
	if (f->cancel_flag) *(f->cancel_flag) = 1;
	// A parked fiber is not running, so the flag alone would never be
	// observed — requeue any fiber waiting on this future so it resumes and
	// sees the cancellation at its next checkpoint.
	pthread_mutex_lock(&f->mu);
	struct nomen_fiber *w = f->fiber_waiters;
	f->fiber_waiters = NULL;
	pthread_mutex_unlock(&f->mu);
	if (w) __nomen_fiber_wake_waiters(w);
	// The fiber that owns this task may be parked on a primitive waitq;
	// schedule it so it resumes and observes the flag (idempotent).
	if (f->owning_fiber) __nomen_fiber_schedule(f->owning_fiber);
}
// Race-mode helpers — see build_c POOL_HEADER for semantics.
int __nomen_future_is_done(struct nomen_future *f) {
	pthread_mutex_lock(&f->mu);
	int d = f->done;
	pthread_mutex_unlock(&f->mu);
	return d;
}
int __nomen_nursery_race_wait(struct nomen_future **futures, int count, long long deadline_ms) {
	if (count <= 0) return 0;
	struct timespec sleep_ts = {0, 1000000};
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
 * aarch64 companion counterpart of the C backend's
 * ensure_concurrency_runtime: appends the pool + fiber runtime text to
 * status.file_scope_c exactly once. Every aarch64 build ends up with it —
 * the precompiled system object references the fiber symbols, so every
 * linked program must define them.
 */
export function ensure_concurrency_runtime_a64(status: BuildStatus): void {
	if (status.pool_runtime_emitted && status.fiber_runtime_emitted) return;
	if (!status.pool_runtime_emitted) {
		status.file_scope_c = (status.file_scope_c ?? "") + POOL_HEADER_C;
		status.pool_runtime_emitted = true;
	}
	if (!status.fiber_runtime_emitted) {
		status.file_scope_c += FIBER_HEADER_C;
		status.fiber_runtime_emitted = true;
	}
}

export const FIBER_HEADER_C = `
#include <stdint.h>
#include <stdlib.h>
#define NOMEN_FIBER_STACK_SIZE (64 * 1024)
enum { NOMEN_FIBER_READY, NOMEN_FIBER_RUNNING, NOMEN_FIBER_PARKED, NOMEN_FIBER_DONE };
// 13 saved words: x19-x28 (callee-saved), x29 (FP), x30 (LR), and SP.
typedef struct { void *regs[13]; } nomen_fiber_ctx;
struct nomen_fiber {
	nomen_fiber_ctx ctx;
	void *stack;
	void (*fn)(void *);
	void *args;
	int state;
	struct nomen_fiber *next;        // run-queue link
	struct nomen_fiber *wait_next;   // primitive waitq link (Channel/Mutex)
	struct nomen_fiber **park_head;  // waitq we are linked in (NULL otherwise)
	struct nomen_future *owning_future;  // this fiber's task future
};
static pthread_mutex_t __nomen_fq_mu = PTHREAD_MUTEX_INITIALIZER;
static struct nomen_fiber *__nomen_fq_head = NULL;
static struct nomen_fiber *__nomen_fq_tail = NULL;
static int __nomen_fiber_coop = 0;
static __thread int __nomen_coop_running = 0;
static __thread nomen_fiber_ctx *__nomen_fiber_ret = NULL;
int __nomen_fiber_pending(void) {
	pthread_mutex_lock(&__nomen_fq_mu);
	int pending = __nomen_fq_head != NULL;
	pthread_mutex_unlock(&__nomen_fq_mu);
	return pending;
}
void __nomen_fiber_schedule(struct nomen_fiber *f) {
	// Only a parked fiber is queued (see the C backend's header): spawn,
	// yield, and park set PARKED first, so a second wake is a no-op and
	// stale waitq entries are harmless.
	if (f->state != NOMEN_FIBER_PARKED) return;
	f->state = NOMEN_FIBER_READY;
	f->next = NULL;
	pthread_mutex_lock(&__nomen_fq_mu);
	if (__nomen_fq_tail) __nomen_fq_tail->next = f;
	else __nomen_fq_head = f;
	__nomen_fq_tail = f;
	pthread_mutex_unlock(&__nomen_fq_mu);
	pthread_mutex_lock(&__nomen_pool_mu);
	pthread_cond_signal(&__nomen_pool_cv);
	pthread_mutex_unlock(&__nomen_pool_mu);
}
static struct nomen_fiber *__nomen_fiber_try_pop(void) {
	pthread_mutex_lock(&__nomen_fq_mu);
	struct nomen_fiber *f = __nomen_fq_head;
	if (f) {
		__nomen_fq_head = f->next;
		if (!__nomen_fq_head) __nomen_fq_tail = NULL;
	}
	pthread_mutex_unlock(&__nomen_fq_mu);
	return f;
}
// Switch: save the current context into *from, restore *to, and return into
// it (ret branches through the restored LR). Suspension overwrites the
// fiber's own context slot — the resume point after the first suspension.
__attribute__((naked)) void ___nomen_fiber_switch(nomen_fiber_ctx *from, nomen_fiber_ctx *to) {
	__asm__ volatile(
		"stp x19, x20, [x0, #0]\\n\\t"
		"stp x21, x22, [x0, #16]\\n\\t"
		"stp x23, x24, [x0, #32]\\n\\t"
		"stp x25, x26, [x0, #48]\\n\\t"
		"stp x27, x28, [x0, #64]\\n\\t"
		"stp x29, x30, [x0, #80]\\n\\t"
		"mov x2, sp\\n\\t"
		"str x2, [x0, #96]\\n\\t"
		"ldp x19, x20, [x1, #0]\\n\\t"
		"ldp x21, x22, [x1, #16]\\n\\t"
		"ldp x23, x24, [x1, #32]\\n\\t"
		"ldp x25, x26, [x1, #48]\\n\\t"
		"ldp x27, x28, [x1, #64]\\n\\t"
		"ldp x29, x30, [x1, #80]\\n\\t"
		"ldr x2, [x1, #96]\\n\\t"
		"mov sp, x2\\n\\t"
		"ret\\n\\t"
	);
}
// First entry into a fiber: the make step built a frame whose [sp] holds the
// fiber pointer and whose LR is this function. Never returns.
__attribute__((naked)) void ___nomen_fiber_entry(void) {
	__asm__ volatile(
		"ldr x0, [sp]\\n\\t"
		"bl _nomen_fiber_run_body\\n\\t"
		"brk #1\\n\\t"
	);
}
// Non-static: its only reference is the textual branch in the naked entry
// asm, so the compiler must always emit the symbol.
void nomen_fiber_run_body(struct nomen_fiber *self) {
	__nomen_current_fiber = self;
	self->fn(self->args);
	self->state = NOMEN_FIBER_DONE;
	___nomen_fiber_switch(&self->ctx, __nomen_fiber_ret);
}
// Suspend the current fiber: its continuation lands in self->ctx (state is
// set by the caller BEFORE suspending — see the C backend's FIBER_HEADER).
void __nomen_fiber_pause(void) {
	struct nomen_fiber *self = __nomen_current_fiber;
	___nomen_fiber_switch(&self->ctx, __nomen_fiber_ret);
}
// Wake a list of fibers collected by __nomen_future_complete: requeue each
// onto the run queue. Defined here (not in the pool text) because walking
// the list needs the full nomen_fiber type.
static void __nomen_fiber_wake_waiters(struct nomen_fiber *w) {
	while (w) {
		struct nomen_fiber *next = w->next;
		w->next = NULL;
		__nomen_fiber_schedule(w);
		w = next;
	}
}
// Park the current fiber until the future completes. Park-before-signal —
// see the C backend's FIBER_HEADER.
static void __nomen_fiber_park_on_future(struct nomen_future *f) {
	struct nomen_fiber *self = __nomen_current_fiber;
	pthread_mutex_lock(&f->mu);
	if (f->done) {
		pthread_mutex_unlock(&f->mu);
		return;
	}
	self->next = f->fiber_waiters;
	f->fiber_waiters = self;
	self->state = NOMEN_FIBER_PARKED;
	pthread_mutex_unlock(&f->mu);
	__nomen_fiber_pause();
}
// Run a fiber on the calling thread until it suspends or finishes. Counted
// as pool-busy so nested Thread spawns grow the pool instead of deadlocking.
static void __nomen_fiber_run_here(struct nomen_fiber *f) {
	pthread_mutex_lock(&__nomen_pool_mu);
	__nomen_pool_busy++;
	pthread_mutex_unlock(&__nomen_pool_mu);
	nomen_fiber_ctx ret;
	__nomen_fiber_ret = &ret;
	f->state = NOMEN_FIBER_RUNNING;
	__nomen_current_fiber = f;
	// Restore the fiber's task-local state: the worker may have run other
	// tasks since this fiber last ran, so the trampoline's entry-time values
	// are long gone (and a stale NULL would hide cancellation).
	__nomen_current_cancel_flag = f->owning_future ? f->owning_future->cancel_flag : NULL;
	___nomen_fiber_switch(&ret, &f->ctx);
	__nomen_current_fiber = NULL;
	if (f->state == NOMEN_FIBER_DONE) {
		free(f->stack);
		free(f);
	}
	pthread_mutex_lock(&__nomen_pool_mu);
	__nomen_pool_busy--;
	pthread_mutex_unlock(&__nomen_pool_mu);
}
// Park the current fiber on a primitive's wait queue — see the C backend's
// FIBER_HEADER for the park-before-signal contract and the return value.
int __nomen_fiber_waitq_park(struct nomen_fiber **head, void *mu, void *cv) {
	if (__nomen_current_cancel_flag && *__nomen_current_cancel_flag) return 0;
	struct nomen_fiber *self = __nomen_current_fiber;
	if (!self) {
		pthread_cond_wait((pthread_cond_t *)cv, (pthread_mutex_t *)mu);
		return 1;
	}
	self->wait_next = *head;
	*head = self;
	self->park_head = head;
	self->state = NOMEN_FIBER_PARKED;
	pthread_mutex_unlock((pthread_mutex_t *)mu);
	__nomen_fiber_pause();
	pthread_mutex_lock((pthread_mutex_t *)mu);
	if (self->park_head) {
		struct nomen_fiber **p = self->park_head;
		while (*p) {
			if (*p == self) {
				*p = self->wait_next;
				break;
			}
			p = &(*p)->wait_next;
		}
		self->park_head = NULL;
	}
	self->wait_next = NULL;
	return __nomen_current_cancel_flag && *__nomen_current_cancel_flag ? 0 : 1;
}
void __nomen_fiber_waitq_wake(struct nomen_fiber **head) {
	struct nomen_fiber *w = *head;
	*head = NULL;
	while (w) {
		struct nomen_fiber *nx = w->wait_next;
		w->wait_next = NULL;
		w->park_head = NULL;
		__nomen_fiber_schedule(w);
		w = nx;
	}
}
void __nomen_fiber_yield(void);
// Lock a pthread mutex — cooperative fibers try-lock and yield; everything
// else blocks (see the C backend's header / FOLLOWUP.md).
void __nomen_mutex_lock(void *mu) {
	if (__nomen_current_fiber && __nomen_fiber_coop) {
		while (pthread_mutex_trylock((pthread_mutex_t *)mu) != 0) {
			__nomen_fiber_yield();
		}
		return;
	}
	pthread_mutex_lock((pthread_mutex_t *)mu);
}
void __nomen_fiber_yield(void) {
	struct nomen_fiber *self = __nomen_current_fiber;
	if (!self) return;
	self->state = NOMEN_FIBER_PARKED;
	__nomen_fiber_schedule(self);
	__nomen_fiber_pause();
}
// Run every currently-runnable fiber to its next suspension. Reentrancy is
// guarded (see the C backend's FIBER_HEADER).
static int __nomen_coop_atexit = 0;
void __nomen_fiber_drain_all(void) {
	if (__nomen_coop_running) return;
	__nomen_coop_running = 1;
	struct nomen_fiber *f;
	while ((f = __nomen_fiber_try_pop()) != NULL) {
		__nomen_fiber_run_here(f);
	}
	__nomen_coop_running = 0;
}
static void __nomen_fiber_coop_drain(void) {
	__nomen_fiber_drain_all();
}
int __nomen_fiber_is_active(void) {
	return __nomen_current_fiber != NULL;
}
void __nomen_fiber_set_cooperative(int on) {
	__nomen_fiber_coop = on;
}
// Create a fiber running fn(args) and enqueue it. Cooperative mode defers
// execution to the next drain (a would-block wait, or process exit) and
// never starts worker threads; threaded mode ensures the pool exists so a
// worker picks the fiber up.
static void __nomen_fiber_spawn_common(void (*fn)(void *), void *args, struct nomen_future *future, void *stack, size_t stack_size) {
	struct nomen_fiber *f = (struct nomen_fiber *)malloc(sizeof(struct nomen_fiber));
	f->fn = fn;
	f->args = args;
	f->state = NOMEN_FIBER_PARKED;   // schedule() queues PARKED fibers
	f->next = NULL;
	f->wait_next = NULL;
	f->park_head = NULL;
	f->owning_future = future;
	if (future) future->owning_fiber = f;
	f->stack = NULL;
	// Build the initial frame: 16-byte-aligned top, fiber pointer at [sp],
	// zeroed callee-saved registers, FP = 0 (ends backtraces), LR = entry.
	void *stack_top;
	if (stack) {
		stack_top = (void *)((uintptr_t)stack + stack_size);
	} else {
		f->stack = malloc(NOMEN_FIBER_STACK_SIZE);
		stack_top = (void *)((uintptr_t)f->stack + NOMEN_FIBER_STACK_SIZE);
	}
	uintptr_t sp = ((uintptr_t)stack_top) & ~(uintptr_t)15;
	sp -= 16;
	*(void **)sp = f;
	for (int i = 0; i < 10; i++) f->ctx.regs[i] = 0;
	f->ctx.regs[10] = 0;
	f->ctx.regs[11] = (void *)___nomen_fiber_entry;
	f->ctx.regs[12] = (void *)sp;
	__nomen_fiber_schedule(f);
	if (__nomen_fiber_coop) {
		if (!__nomen_coop_atexit) {
			__nomen_coop_atexit = 1;
			atexit(__nomen_fiber_drain_all);
		}
	} else {
		__nomen_pool_ensure();
	}
}
void __nomen_fiber_spawn(void (*fn)(void *), void *args, struct nomen_future *future) {
	__nomen_fiber_spawn_common(fn, args, future, NULL, 0);
}
void __nomen_fiber_spawn_on(void (*fn)(void *), void *args, struct nomen_future *future, void *stack, size_t stack_size) {
	__nomen_fiber_spawn_common(fn, args, future, stack, stack_size);
}
`;

/**
 * Build a `spawn <call>` node for aarch64.
 *
 * Strategy: the per-site trampoline is emitted as a C function in the
 * companion file (avoiding cross-object function pointer issues). The
 * assembly at the call site builds the arg struct, allocates the future,
 * then calls __nomen_spawn_submit (a C helper) which does the pool submit
 * and Task construction. This keeps the assembly minimal and the complex
 * allocation/submit logic in portable C.
 */
export default function build_spawn_node(node: SpawnNode, status: BuildStatus) {
	const call = node.call;
	const func_name = c_function_name(emission_label(call.resolved_function ?? call));
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	// Emit pool infrastructure on first spawn (file-scope C companion).
	ensure_concurrency_runtime_a64(status);

	const struct_name = `__nomen_spawn_${id}_args`;
	const tramp_name = `__nomen_spawn_${id}_trampoline`;
	const submit_name = `nomen_spawn_${id}_submit`;

	// Resolve each arg's C type. Primitives and the fat `string` (the
	// 16-byte nomen_string — two AAPCS register slots) go through c_type so
	// the companion C signature matches the asm's actual 64-bit values (the
	// raw Nomen names either don't exist in C (`string`) or are the wrong
	// width (`int` is C `long`)). Classes/traits are heap pointers.
	const arg_c_types: string[] = [];
	for (let i = 0; i < call.params.length; i++) {
		const arg_type = type_from_value_node(call.params[i]);
		const mono_name = mono_type_name(arg_type);
		const is_class = !!status.structs.find((s) => s.name === mono_name && s.is_class);
		const is_trait = !!status.traits.find((t) => t.name === mono_name);
		arg_c_types.push(is_class || is_trait ? `struct ${mono_name} *` : `${c_type(mono_name)}`);
	}

	// Determine return type.
	const return_type_name = node.function_return_type?.name;
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
			? c_type(return_type_name)
			: "void";
	// The result cell is always 16 bytes: Task.nm's raw `result` asm loads
	// BOTH words ([slot], [slot+8]) for every T (fat strings ride the pair,
	// scalars ignore x1), so the cell must be at least a pair wide even when
	// the typed write below stores a single word.
	const slot_c_type = returns_value ? c_ret_type : "unsigned long long";

	// --- Emit trampoline + submit helper as C companion ---

	let tramp_c = `// --- spawn site ${id} trampoline ---\n`;
	// Forward-declare the user function.
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
	tramp_c += `\t${slot_c_type} *result_slot;\n`;
	tramp_c += `\tunsigned long long *cancel_flag;\n`;
	tramp_c += `\tstruct nomen_future *future;\n`;
	tramp_c += `};\n`;

	// Trampoline: called by pool worker. Static — only used within companion.
	tramp_c += `static void ${tramp_name}(void *p) {\n`;
	tramp_c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)p;\n`;
	tramp_c += `\t__nomen_current_cancel_flag = a->cancel_flag;\n`;
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
		tramp_c += `\t*(a->result_slot) = _r;\n`;
	}
	tramp_c += `\t__nomen_current_cancel_flag = NULL;\n`;
	tramp_c += `\t__nomen_future_complete(a->future);\n`;
	tramp_c += `\t__nomen_future_release(a->future);\n`; // a freed via f->owner_args at last release
	tramp_c += `}\n`;

	// Nursery state + fire-and-forget detection.
	const nursery_id = status.nursery_stack?.at(-1);
	const nursery_off =
		nursery_id !== undefined ? status.nursery_offsets?.get(nursery_id) : undefined;
	const fire_and_forget = !!node.is_statement;
	const refs = fire_and_forget
		? nursery_id !== undefined
			? 2
			: 1
		: nursery_id !== undefined
			? 3
			: 2;

	// Submit helper: allocates args struct, copies fields from asm values,
	// allocates future, submits to pool. For captured spawns, also allocates
	// Task and returns its pointer. For fire-and-forget, returns NULL.
	// When inside a nursery, the asm spawn site passes the nursery's stack
	// futures/count addresses as the last two args; the helper pushes the
	// future to that per-invocation state.
	// Called from asm with: x0=arg0, x1=arg1, ... (up to 6 args in regs).
	tramp_c += `void *${submit_name}(`;
	for (let i = 0; i < arg_c_types.length; i++) {
		if (i > 0) tramp_c += ", ";
		tramp_c += `${arg_c_types[i]} arg${i}`;
	}
	if (nursery_id !== undefined) {
		if (arg_c_types.length > 0) tramp_c += ", ";
		tramp_c += `unsigned long long *__nomen_nursery_futures, int *__nomen_nursery_count`;
	}
	tramp_c += `) {\n`;
	tramp_c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		tramp_c += `\ta->arg${i} = arg${i};\n`;
	}
	// Uniform 16-byte cell (see slot_c_type above), zeroed so the unwritten
	// len half of a scalar result reads 0.
	tramp_c += `\ta->result_slot = (${slot_c_type} *)malloc(16);\n`;
	tramp_c += `\tmemset(a->result_slot, 0, 16);\n`;
	tramp_c += `\ta->cancel_flag = (unsigned long long *)malloc(sizeof(unsigned long long));\n`;
	tramp_c += `\t*(a->cancel_flag) = 0;\n`;
	tramp_c += `\tstruct nomen_future *f = (struct nomen_future *)malloc(sizeof(struct nomen_future));\n`;
	tramp_c += `\tpthread_mutex_init(&f->mu, NULL);\n`;
	tramp_c += `\tpthread_cond_init(&f->cv, NULL);\n`;
	tramp_c += `\tf->done = 0;\n`;
	tramp_c += `\tf->refs = ${refs};\n`;
	tramp_c += `\tf->cancel_flag = a->cancel_flag;\n`;
	tramp_c += `\tf->result_slot = a->result_slot;\n`;
	tramp_c += `\ta->future = f;\n`;
	tramp_c += `\tf->owner_args = a;\n`;
	tramp_c += `\tf->fiber_waiters = NULL;\n`;
	tramp_c += `\tf->owning_fiber = 0;\n`;
	tramp_c += `\t__nomen_pool_submit(${tramp_name}, a);\n`;
	if (nursery_id !== undefined) {
		tramp_c += `\t__nomen_nursery_futures[(*__nomen_nursery_count)++] = (unsigned long long)f;\n`;
	}
	if (fire_and_forget) {
		// Fire-and-forget: no Task handle needed. The trampoline (and nursery,
		// if any) manage the future lifetime.
		tramp_c += `\treturn (void *)0;\n`;
	} else {
		// Allocate Task and return pointer.
		const mono_task_name = mono_type_name("Task", call.type?.type_args);
		tramp_c += `\tstruct ${mono_task_name} *t = (struct ${mono_task_name} *)malloc(sizeof(struct ${mono_task_name}));\n`;
		tramp_c += `\tt->handle = 0;\n`;
		tramp_c += `\tt->done = 0;\n`;
		tramp_c += `\tt->result_slot = (unsigned long long)a->result_slot;\n`;
		tramp_c += `\tt->cancel_flag = (unsigned long long)a->cancel_flag;\n`;
		tramp_c += `\tt->future = (unsigned long long)f;\n`;
		tramp_c += `\treturn t;\n`;
	}
	tramp_c += `}\n`;

	if (!status.file_scope_c) status.file_scope_c = "";
	status.file_scope_c += tramp_c;

	// --- Emit assembly: build arg registers and call submit helper ---
	status.code += `// spawn site ${id}\n`;

	// When inside a nursery, two extra trailing args carry the addresses of
	// the nursery's per-invocation futures array and count slot (on the
	// caller's stack). They occupy the last two arg slots.
	const nursery_extra = nursery_off ? 2 : 0;

	// A fat `string` argument rides the (ptr, len) pair in x0/x1 and occupies
	// TWO consecutive AAPCS slots (matching the `nomen_string` by-value param
	// of the submit helper) — same detection rule as arg_c_types above.
	const fat_string_args = call.params.map(spawn_arg_is_string);
	const arg_slot: number[] = [];
	let total_arg_slots = 0;
	for (let i = 0; i < call.params.length; i++) {
		arg_slot.push(total_arg_slots);
		total_arg_slots += fat_string_args[i] ? 2 : 1;
	}
	total_arg_slots += nursery_extra;

	if (total_arg_slots === 0) {
		status.code += `bl _${submit_name}\n`;
	} else {
		// Build each arg and spill it to a dedicated frame slot (building an
		// argument can clobber x1..x7, so registers are loaded only after
		// every arg is staged), then load the argument registers and call.
		// Mirrors the general call path in build_function_call_node.
		const args_base = allocate_stack_space(status, total_arg_slots * 8, 16);
		for (let i = 0; i < call.params.length; i++) {
			status.code += `// Build arg${i}\n`;
			build_node(call.params[i], status);
			// Ensure newline after build_node (value nodes don't add one).
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `str x0, [x29, #${args_base + arg_slot[i] * 8}]\n`;
			if (fat_string_args[i]) {
				// The pair's len half rides x1 — spill both halves.
				status.code += `str x1, [x29, #${args_base + (arg_slot[i] + 1) * 8}]\n`;
			}
		}
		if (nursery_off) {
			// Compute addresses of nursery futures array and count slot.
			status.code += `add x0, x29, #${nursery_off.futures_off}\n`;
			status.code += `str x0, [x29, #${args_base + (total_arg_slots - 2) * 8}]\n`;
			status.code += `add x0, x29, #${nursery_off.count_off}\n`;
			status.code += `str x0, [x29, #${args_base + (total_arg_slots - 1) * 8}]\n`;
		}
		// Load each staged slot into its argument register. Slots past x0..x7
		// go in the caller's outgoing area at [sp] for the call (AAPCS64).
		const NUM_REG_ARGS = 8;
		const overflow_count = Math.max(0, total_arg_slots - NUM_REG_ARGS);
		if (overflow_count > 0) {
			const outgoing_size = Math.ceil((overflow_count * 8) / 16) * 16;
			status.code += `sub sp, sp, #${outgoing_size}\n`;
			for (let k = 0; k < overflow_count; k++) {
				status.code += `ldr x9, [x29, #${args_base + (NUM_REG_ARGS + k) * 8}]\n`;
				status.code += `str x9, [sp, #${k * 8}]\n`;
			}
		}
		for (let s = 0; s < Math.min(total_arg_slots, NUM_REG_ARGS); s++) {
			status.code += `ldr x${s}, [x29, #${args_base + s * 8}]\n`;
		}
		status.code += `bl _${submit_name}\n`;
		if (overflow_count > 0) {
			const outgoing_size = Math.ceil((overflow_count * 8) / 16) * 16;
			status.code += `add sp, sp, #${outgoing_size}\n`;
		}
	}
	// x0 = Task pointer (returned by submit helper).
}

/**
 * Whether a spawn argument rides the fat-string (ptr, len) pair ABI: its
 * static type names `string`, or it is a string literal (whose ValueNode.type
 * may be unset). Mirrors arg_is_string in build_function_call_node.
 */
export function spawn_arg_is_string(node: BaseNode): boolean {
	const v = node as { value?: string };
	if (node.node_type === "value" && typeof v.value === "string" && v.value.startsWith('"')) {
		return true;
	}
	const t = type_from_value_node(node);
	return t?.name === "string" && !t.is_view && !t.is_array;
}
