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
#include <stdio.h>
#include <time.h>
// The spawn runtime speaks the closure descriptor ABI (docs/CLOSURE_PLAN.md):
// a submitted task IS a "struct nomen_closure *" whose code receives the
// closure itself ("void (*)(struct nomen_closure *)" — env is reachable
// through it). Guarded so a companion that already carries the definition
// (e.g. from a future preamble) stays single-definition.
#ifndef NOMEN_CLOSURE_STRUCT
#define NOMEN_CLOSURE_STRUCT
struct nomen_closure {
	void *code;
	void *env;
	int owned;
	void (*destroy_env)(void *);
};
#endif
// The uniform free-if-owned arm (the same teardown a func-typed local gets
// at scope exit): a heap descriptor (owned = 1) runs its env destructor,
// then frees the env and the descriptor. Static descriptors (owned = 0)
// own nothing and are never freed. The future holds the task closure via
// owner_args and disposes it at the last release — the same lifetime the
// bare args struct had (ordered after every use, so a worker's free never
// races the submitting thread's post-submit allocations).
void __nomen_closure_dispose(struct nomen_closure *c) {
	if (!c || !c->owned) return;
	if (c->destroy_env) c->destroy_env(c->env);
	free(c->env);
	free(c);
}
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
// Non-fiber threads currently committed to a blocking wait — see the C
// backend's POOL_HEADER: the worker-side deadlock check only fires when
// this is nonzero, because a non-fiber thread not blocked here may be
// mid-statement about to send/wake (invisible to the runtime).
static int __nomen_block_waiters = 0;
// Defined (initialized) in the pool section below — see the C backend's
// POOL_HEADER for the tentative-declaration note. Non-static here to match
// the pool section's external linkage (a static declaration followed by a
// non-static definition is a linkage error).
pthread_mutex_t __nomen_pool_mu;
pthread_cond_t __nomen_pool_cv;
// Deadlock detector (defined at the end of FIBER_HEADER_C) — see the C
// backend's FIBER_HEADER for the full model: commit-point check from the
// indefinite future waits, worker-side check from the idle pool loop.
static void __nomen_deadlock_check(const char *site);
static int __nomen_deadlock_check_worker(void);
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
		// Block-forever commit — see the C backend's __nomen_future_wait.
		pthread_mutex_lock(&__nomen_pool_mu);
		__nomen_block_waiters++;
		pthread_mutex_unlock(&__nomen_pool_mu);
		__nomen_deadlock_check("waiting on a task");
		pthread_cond_wait(&f->cv, &f->mu);
		pthread_mutex_lock(&__nomen_pool_mu);
		__nomen_block_waiters--;
		pthread_mutex_unlock(&__nomen_pool_mu);
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
			// Indefinite wait — see the C backend's __nomen_future_timedwait:
			// finite deadlines self-wake and are skipped on purpose.
			pthread_mutex_lock(&__nomen_pool_mu);
			__nomen_block_waiters++;
			pthread_mutex_unlock(&__nomen_pool_mu);
			__nomen_deadlock_check("waiting on a task");
			pthread_cond_wait(&f->cv, &f->mu);
			pthread_mutex_lock(&__nomen_pool_mu);
			__nomen_block_waiters--;
			pthread_mutex_unlock(&__nomen_pool_mu);
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
		// The task closure is owned by the future — disposed at the last
		// release (see __nomen_closure_dispose above for the lifetime note).
		__nomen_closure_dispose((struct nomen_closure *)f->owner_args);
		free(f);
	}
}
struct nomen_pool_task {
	struct nomen_closure *task;
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
			// Worker-side deadlock check — see the C backend's pool worker.
			// A 1 return means the pool state moved while the detector
			// slept; re-run the predicate instead of condvar-waiting past
			// the signal that arrived during the release.
			if (__nomen_deadlock_check_worker()) continue;
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
		((void (*)(struct nomen_closure *))t->task->code)(t->task);
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
void __nomen_pool_submit(struct nomen_closure *task) {
	__nomen_pool_ensure();
	struct nomen_pool_task *t = (struct nomen_pool_task *)malloc(sizeof(struct nomen_pool_task));
	t->task = task;
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
// Register a future with a nursery's growable list — see the C backend's
// POOL_HEADER. "slots" points at the list's storage slot (NULL, grown by
// realloc); shared by the direct and escape-hatch registration sites.
void __nomen_nursery_track(void **slots, int *count, int *cap, struct nomen_future *f) {
	if (*count >= *cap) {
		*cap = *cap ? *cap * 2 : 16;
		*slots = realloc(*slots, (size_t)*cap * sizeof(struct nomen_future *));
	}
	((struct nomen_future **)*slots)[(*count)++] = f;
}
// ---- detached daemon tasks: the Thread(fn(args)).detach() form ----
// Mirror of the C backend's POOL_HEADER section — the std::thread::spawn
// contract: the call runs on its OWN pthread, never a pool worker, and
// nobody joins it; process exit kills it mid-execution by design. The
// task closure is disposed by the one thread that ran it — never inside
// the generated body (that was a double free before the closure ABI).
struct nomen_detached_start {
	struct nomen_closure *task;
};
static void *__nomen_detached_run(void *p) {
	struct nomen_detached_start *d = (struct nomen_detached_start *)p;
	__nomen_current_cancel_flag = NULL;
	((void (*)(struct nomen_closure *))d->task->code)(d->task);
	__nomen_closure_dispose(d->task);
	free(d);
	return NULL;
}
static void __nomen_task_detach(struct nomen_closure *task) {
	struct nomen_detached_start *d =
		(struct nomen_detached_start *)malloc(sizeof(struct nomen_detached_start));
	d->task = task;
	pthread_attr_t attr;
	pthread_attr_init(&attr);
	pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
	pthread_t t;
	if (pthread_create(&t, &attr, __nomen_detached_run, d) != 0) {
		__nomen_closure_dispose(task);
		free(d);
		fprintf(stderr, "warning: Thread(fn(args)).detach() could not start a thread\\n");
	}
	pthread_attr_destroy(&attr);
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
	// The system object is linked into every program next to that program's
	// own companion, which always defines the runtime; a copy here would
	// duplicate every symbol at link time. The system object's references
	// resolve against the user companion instead.
	if (status.emit_mode === "system") return;
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
#include <stdio.h>
#include <stddef.h>
#include <stdlib.h>
#define NOMEN_FIBER_STACK_SIZE (64 * 1024)
enum { NOMEN_FIBER_READY, NOMEN_FIBER_RUNNING, NOMEN_FIBER_PARKED, NOMEN_FIBER_DONE };
// 13 saved words: x19-x28 (callee-saved), x29 (FP), x30 (LR), and SP.
typedef struct { void *regs[13]; } nomen_fiber_ctx;
struct nomen_fiber {
	nomen_fiber_ctx ctx;
	void *stack;
	struct nomen_closure *task;      // the spawned task closure (code sees it)
	int state;
	struct nomen_fiber *next;        // run-queue link
	struct nomen_fiber *wait_next;   // primitive waitq link (Channel/Mutex)
	struct nomen_fiber **park_head;  // waitq we are linked in (NULL otherwise)
	struct nomen_future *owning_future;  // this fiber's task future
	struct nomen_fiber *all_next;    // all-fibers registry link (deadlock dump)
	// Park diagnostics, read by the deadlock dump — see the C backend's
	// FIBER_HEADER: set only once the park is fully registered, cleared on
	// resume; PARKED with a NULL kind is a transient and never counted.
	const char *park_kind;
	void *park_obj;
};
static pthread_mutex_t __nomen_fq_mu = PTHREAD_MUTEX_INITIALIZER;
static struct nomen_fiber *__nomen_fq_head = NULL;
static struct nomen_fiber *__nomen_fq_tail = NULL;
// All live fibers (guarded by __nomen_fq_mu) — see the C backend's
// FIBER_HEADER: the deadlock dump walks this because a parked fiber lives
// on no single list.
static struct nomen_fiber *__nomen_fiber_all = NULL;
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
	((void (*)(struct nomen_closure *))self->task->code)(self->task);
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
	self->park_kind = "future";
	self->park_obj = f;
	self->state = NOMEN_FIBER_PARKED;
	pthread_mutex_unlock(&f->mu);
	__nomen_fiber_pause();
	self->park_kind = NULL;
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
		// Unlink from the all-fibers registry before freeing.
		pthread_mutex_lock(&__nomen_fq_mu);
		struct nomen_fiber **all = &__nomen_fiber_all;
		while (*all && *all != f) all = &(*all)->all_next;
		if (*all) *all = f->all_next;
		pthread_mutex_unlock(&__nomen_fq_mu);
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
	// Park kind inferred from the call shape (channel passes its condvar;
	// the mutex site passes NULL) — see the C backend's FIBER_HEADER.
	self->park_kind = cv ? "channel" : "mutex";
	self->park_obj = head;
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
	self->park_kind = NULL;
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
// Nomen Mutex layout — one allocation handed to the Mutex class raw bodies
// (which call the helpers below; the class never dereferences the handle
// itself). wmu guards the fiber wait list and is deliberately NOT the lock:
// a holder may park mid-critical-section, and a waiter must be able to
// register on the wait list without blocking behind it. Defined under a
// guard because the companion C and the Mutex class body compile into the
// same TU in single-companion builds.
#ifndef NOMEN_MUTEX_STRUCT
#define NOMEN_MUTEX_STRUCT
struct nomen_mutex {
	pthread_mutex_t mu;   // the lock
	pthread_mutex_t wmu;  // wait-list guard (held only for bookkeeping)
	struct nomen_fiber *waiters;
	void *owner;  // current holder (fiber handle; NULL for a non-fiber task) —
	              // deadlock-dump diagnostics only, read without its own lock
};
#endif
// Allocate and initialize a Mutex handle (Mutex.#init).
void *__nomen_mutex_create(void) {
	struct nomen_mutex *m = (struct nomen_mutex *)malloc(sizeof(struct nomen_mutex));
	pthread_mutex_init(&m->mu, NULL);
	pthread_mutex_init(&m->wmu, NULL);
	m->waiters = NULL;
	m->owner = NULL;
	return m;
}
// Unlock and wake fibers parked on the mutex (Mutex.unlock).
void __nomen_mutex_unlock_wake(void *mp) {
	struct nomen_mutex *m = (struct nomen_mutex *)mp;
	m->owner = NULL;
	pthread_mutex_unlock(&m->mu);
	pthread_mutex_lock(&m->wmu);
	__nomen_fiber_waitq_wake(&m->waiters);
	pthread_mutex_unlock(&m->wmu);
}
// Destroy and free the Mutex handle (Mutex.#destroy).
void __nomen_mutex_dispose(void *mp) {
	struct nomen_mutex *m = (struct nomen_mutex *)mp;
	pthread_mutex_destroy(&m->mu);
	pthread_mutex_destroy(&m->wmu);
	free(m);
}
// Lock a Nomen mutex — see the C backend's FIBER_HEADER for the full
// contract: cooperative fibers try-lock and yield; threaded-model fibers
// park on the mutex's wait list (woken by unlock); cancellation keeps
// waiting rather than returning without the lock.
void __nomen_mutex_lock(void *mp) {
	struct nomen_mutex *m = (struct nomen_mutex *)mp;
	if (__nomen_current_fiber && __nomen_fiber_coop) {
		while (pthread_mutex_trylock(&m->mu) != 0) {
			__nomen_fiber_yield();
		}
		m->owner = __nomen_current_fiber;
		return;
	}
	if (__nomen_current_fiber) {
		for (;;) {
			if (pthread_mutex_trylock(&m->mu) == 0) {
				m->owner = __nomen_current_fiber;
				return;
			}
			pthread_mutex_lock(&m->wmu);
			if (pthread_mutex_trylock(&m->mu) == 0) {
				pthread_mutex_unlock(&m->wmu);
				m->owner = __nomen_current_fiber;
				return;
			}
			__nomen_fiber_waitq_park(&m->waiters, &m->wmu, NULL);
			pthread_mutex_unlock(&m->wmu);
			if (__nomen_current_cancel_flag && *__nomen_current_cancel_flag) {
				__nomen_fiber_yield();
			}
		}
	}
	pthread_mutex_lock(&m->mu);
	m->owner = NULL;
}
void __nomen_fiber_yield(void) {
	struct nomen_fiber *self = __nomen_current_fiber;
	if (!self) return;
	// A yield is transient — never present it as a real park to the
	// deadlock detector (see the C backend's FIBER_HEADER).
	self->park_kind = NULL;
	self->park_obj = NULL;
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
static void __nomen_fiber_spawn_common(struct nomen_closure *task, struct nomen_future *future, void *stack, size_t stack_size) {
	struct nomen_fiber *f = (struct nomen_fiber *)malloc(sizeof(struct nomen_fiber));
	f->task = task;
	f->state = NOMEN_FIBER_PARKED;   // schedule() queues PARKED fibers
	f->next = NULL;
	f->wait_next = NULL;
	f->park_head = NULL;
	f->park_kind = NULL;             // parked-without-a-kind = transient
	f->park_obj = NULL;
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
	// Join the all-fibers registry (deadlock dump) before first schedule.
	pthread_mutex_lock(&__nomen_fq_mu);
	f->all_next = __nomen_fiber_all;
	__nomen_fiber_all = f;
	pthread_mutex_unlock(&__nomen_fq_mu);
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

// ---- async I/O: netpoller (ASYNC_PLAN.md Phase 3) ----
// Sockets are registered here by __nomen_io_wait. A poller thread waits on
// kqueue (darwin) / epoll (linux) and schedules the parked fiber when its fd
// is ready. Non-fiber contexts fall back to a short pollloop so the cancel
// flag is still observed. One persistent waiter slot per fd, so a resumed or
// cancelled fiber and a racing poller never touch freed memory.
#include <poll.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <sys/event.h>
#else
#include <sys/epoll.h>
#endif
struct nomen_io_waiter {
	int fd;
	int want_write;
	int active;
	struct nomen_fiber *fiber;
};
static pthread_mutex_t __nomen_io_mu = PTHREAD_MUTEX_INITIALIZER;
static int __nomen_io_init = 0;
static volatile int __nomen_io_quitting = 0;
static int __nomen_io_pipe[2] = { -1, -1 };
static pthread_t __nomen_io_thread;
#if defined(__APPLE__)
static int __nomen_io_kq = -1;
#else
static int __nomen_io_epfd = -1;
#endif
static struct nomen_io_waiter **__nomen_io_slots = NULL;
static int __nomen_io_slots_cap = 0;
static void *__nomen_io_poller(void *arg) {
	(void)arg;
	for (;;) {
#if defined(__APPLE__)
		struct kevent evs[128];
		int n = kevent(__nomen_io_kq, NULL, 0, evs, 128, NULL);
		if (n < 0) {
			if (errno == EINTR) continue;
			break;
		}
		for (int i = 0; i < n; i++) {
			struct nomen_io_waiter *w = (struct nomen_io_waiter *)evs[i].udata;
			int fd = (int)evs[i].ident;
#else
		struct epoll_event evs[128];
		int n = epoll_wait(__nomen_io_epfd, evs, 128, -1);
		if (n < 0) {
			if (errno == EINTR) continue;
			break;
		}
		for (int i = 0; i < n; i++) {
			struct nomen_io_waiter *w = (struct nomen_io_waiter *)evs[i].data.ptr;
			int fd = evs[i].data.fd;
#endif
			if (!w) continue;   // the shutdown pipe
			pthread_mutex_lock(&__nomen_io_mu);
			int was_active = w->active;
			if (was_active && __nomen_io_slots && fd < __nomen_io_slots_cap &&
			    __nomen_io_slots[fd] == w) {
				w->active = 0;
#if defined(__APPLE__)
				struct kevent del;
				EV_SET(&del, fd, w->want_write ? EVFILT_WRITE : EVFILT_READ, EV_DELETE, 0, 0, NULL);
				kevent(__nomen_io_kq, &del, 1, NULL, 0, NULL);
#else
				epoll_ctl(__nomen_io_epfd, EPOLL_CTL_DEL, fd, NULL);
#endif
			}
			pthread_mutex_unlock(&__nomen_io_mu);
			if (was_active) __nomen_fiber_schedule(w->fiber);
		}
		if (__nomen_io_quitting) break;
	}
	return NULL;
}
void __nomen_io_shutdown(void) {
	if (!__nomen_io_init || __nomen_io_quitting) return;
	__nomen_io_quitting = 1;
	if (__nomen_io_pipe[1] >= 0) {
		char b = 1;
		ssize_t _r = write(__nomen_io_pipe[1], &b, 1);
		(void)_r;
	}
	pthread_join(__nomen_io_thread, NULL);
	pthread_mutex_lock(&__nomen_io_mu);
	if (__nomen_io_slots) {
		for (int i = 0; i < __nomen_io_slots_cap; i++) {
			if (__nomen_io_slots[i]) free(__nomen_io_slots[i]);
		}
		free(__nomen_io_slots);
		__nomen_io_slots = NULL;
		__nomen_io_slots_cap = 0;
	}
#if defined(__APPLE__)
	if (__nomen_io_kq >= 0) close(__nomen_io_kq);
	__nomen_io_kq = -1;
#else
	if (__nomen_io_epfd >= 0) close(__nomen_io_epfd);
	__nomen_io_epfd = -1;
#endif
	pthread_mutex_unlock(&__nomen_io_mu);
	if (__nomen_io_pipe[0] >= 0) close(__nomen_io_pipe[0]);
	if (__nomen_io_pipe[1] >= 0) close(__nomen_io_pipe[1]);
	__nomen_io_pipe[0] = __nomen_io_pipe[1] = -1;
}
static struct nomen_io_waiter *__nomen_io_register(int fd, int want_write, struct nomen_fiber *fiber) {
	pthread_mutex_lock(&__nomen_io_mu);
	if (!__nomen_io_init) {
		__nomen_io_init = 1;
		pipe(__nomen_io_pipe);
#if defined(__APPLE__)
		__nomen_io_kq = kqueue();
		struct kevent ch;
		EV_SET(&ch, __nomen_io_pipe[0], EVFILT_READ, EV_ADD, 0, 0, NULL);
		kevent(__nomen_io_kq, &ch, 1, NULL, 0, NULL);
#else
		__nomen_io_epfd = epoll_create1(0);
		struct epoll_event ev;
		ev.events = EPOLLIN;
		ev.data.ptr = NULL;
		ev.data.fd = __nomen_io_pipe[0];
		epoll_ctl(__nomen_io_epfd, EPOLL_CTL_ADD, __nomen_io_pipe[0], &ev);
#endif
		pthread_create(&__nomen_io_thread, NULL, __nomen_io_poller, NULL);
		atexit(__nomen_io_shutdown);
	}
	if (fd >= __nomen_io_slots_cap) {
		int cap = __nomen_io_slots_cap ? __nomen_io_slots_cap : 64;
		while (cap <= fd) cap *= 2;
		__nomen_io_slots = (struct nomen_io_waiter **)realloc(__nomen_io_slots, sizeof(void *) * cap);
		memset(__nomen_io_slots + __nomen_io_slots_cap, 0, sizeof(void *) * (cap - __nomen_io_slots_cap));
		__nomen_io_slots_cap = cap;
	}
	struct nomen_io_waiter *w = __nomen_io_slots[fd];
	if (!w) {
		w = (struct nomen_io_waiter *)malloc(sizeof(struct nomen_io_waiter));
		w->fd = fd;
		__nomen_io_slots[fd] = w;
	}
	w->want_write = want_write;
	w->fiber = fiber;
	w->active = 1;
#if defined(__APPLE__)
	struct kevent ch;
	EV_SET(&ch, fd, want_write ? EVFILT_WRITE : EVFILT_READ, EV_ADD, 0, 0, w);
	kevent(__nomen_io_kq, &ch, 1, NULL, 0, NULL);
#else
	struct epoll_event ev;
	ev.events = want_write ? EPOLLOUT : EPOLLIN;
	ev.data.ptr = w;
	ev.data.fd = fd;
	epoll_ctl(__nomen_io_epfd, EPOLL_CTL_ADD, fd, &ev);
#endif
	pthread_mutex_unlock(&__nomen_io_mu);
	return w;
}
static void __nomen_io_unregister(int fd, struct nomen_io_waiter *w) {
	if (!w) return;
	pthread_mutex_lock(&__nomen_io_mu);
	if (w->active) {
		w->active = 0;
#if defined(__APPLE__)
		struct kevent del;
		EV_SET(&del, fd, w->want_write ? EVFILT_WRITE : EVFILT_READ, EV_DELETE, 0, 0, NULL);
		kevent(__nomen_io_kq, &del, 1, NULL, 0, NULL);
#else
		epoll_ctl(__nomen_io_epfd, EPOLL_CTL_DEL, fd, NULL);
#endif
	}
	pthread_mutex_unlock(&__nomen_io_mu);
}
// Wait until fd is ready for the requested direction. Returns 1 when ready,
// 0 when the current (fiber) task was cancelled while waiting.
int __nomen_io_wait(int fd, int want_write) {
	if (__nomen_current_cancel_flag && *__nomen_current_cancel_flag) return 0;
	if (__nomen_current_fiber) {
		struct nomen_fiber *self = __nomen_current_fiber;
		// Park BEFORE registering (see the C backend's FIBER_HEADER) — and
		// set the park kind only once the registration is live, so PARKED
		// with a NULL kind stays the transient the deadlock detector skips.
		self->state = NOMEN_FIBER_PARKED;
		struct nomen_io_waiter *w = __nomen_io_register(fd, want_write, self);
		self->park_kind = "io";
		self->park_obj = (void *)(intptr_t)fd;
		__nomen_fiber_pause();
		self->park_kind = NULL;
		__nomen_io_unregister(fd, w);
		return __nomen_current_cancel_flag && *__nomen_current_cancel_flag ? 0 : 1;
	}
	struct pollfd p;
	p.fd = fd;
	p.events = want_write ? POLLOUT : POLLIN;
	p.revents = 0;
	for (;;) {
		int r = poll(&p, 1, 50);
		if (r > 0) return 1;
		if (__nomen_current_cancel_flag && *__nomen_current_cancel_flag) return 0;
	}
}

void __nomen_fiber_spawn(struct nomen_closure *task, struct nomen_future *future) {
	__nomen_fiber_spawn_common(task, future, NULL, 0);
}
void __nomen_fiber_spawn_on(struct nomen_closure *task, struct nomen_future *future, void *stack, size_t stack_size) {
	__nomen_fiber_spawn_common(task, future, stack, stack_size);
}

// ---- deadlock detection ("all tasks are asleep", Go's model) ----
// Mirror of the C backend's FIBER_HEADER detector; read that for the full
// model. Trigger points are the moments a thread COMMITS to blocking
// forever: the indefinite future waits (nursery joins, Task.result/wait on
// a raw thread) and an idle pool worker's wait loop when
// __nomen_block_waiters says some thread is so committed. Stuck means: run
// queue empty, pool queue empty, no worker busy, no registered io, and at
// least one fiber parked with a park kind. Both paths sleep 10 ms and
// re-verify before firing, so transient states (a wake mid-delivery) are
// not misjudged. Raw blocking calls outside these primitives (blocking
// FFI, a Thread-model task parked on a condvar) hold no node in the graph
// — the same blind spot as Go's detector.
static int __nomen_deadlock_fired = 0;
// Caller holds __nomen_pool_mu (it stays held): evaluate everything except
// the pool counters under fq_mu (+ io_mu), and count parked fibers.
static int __nomen_deadlock_stuck_locked(int *parked_out) {
	pthread_mutex_lock(&__nomen_fq_mu);
	int stuck = __nomen_fq_head == NULL;
	int parked = 0;
	for (struct nomen_fiber *f = __nomen_fiber_all; f; f = f->all_next) {
		if (f->state == NOMEN_FIBER_PARKED && f->park_kind) parked++;
	}
	pthread_mutex_lock(&__nomen_io_mu);
	if (__nomen_io_slots) {
		for (int i = 0; i < __nomen_io_slots_cap; i++) {
			if (__nomen_io_slots[i] && __nomen_io_slots[i]->active) {
				stuck = 0;
				break;
			}
		}
	}
	pthread_mutex_unlock(&__nomen_io_mu);
	pthread_mutex_unlock(&__nomen_fq_mu);
	*parked_out = parked;
	return stuck;
}
// Dump every parked fiber with its park site. Caller holds fq_mu (and
// pool_mu where applicable); printing only — the fire paths unlock before
// exiting, because exit(2) runs the atexit chain (pool shutdown, io
// shutdown) which must be able to take those locks.
static void __nomen_deadlock_dump(const char *site) {
	fprintf(stderr, "fatal error: all tasks are asleep - deadlock! (%s)\\n", site);
	for (struct nomen_fiber *f = __nomen_fiber_all; f; f = f->all_next) {
		if (f->state != NOMEN_FIBER_PARKED || !f->park_kind) continue;
		if (f->park_kind[0] == 'f') {
			struct nomen_future *fu = (struct nomen_future *)f->park_obj;
			if (fu && fu->owning_fiber) {
				fprintf(stderr, "  task %p parked on future %p (awaiting task %p)\\n",
					(void *)f, (void *)fu, (void *)fu->owning_fiber);
			} else {
				fprintf(stderr, "  task %p parked on future %p\\n", (void *)f, (void *)fu);
			}
		} else if (f->park_kind[0] == 'c') {
			fprintf(stderr, "  task %p parked on channel receive (waiters %p)\\n",
				(void *)f, f->park_obj);
		} else if (f->park_kind[0] == 'm') {
			struct nomen_mutex *m =
				(struct nomen_mutex *)((char *)f->park_obj - offsetof(struct nomen_mutex, waiters));
			if (m->owner) {
				fprintf(stderr, "  task %p parked on mutex %p (held by task %p)\\n",
					(void *)f, (void *)m, m->owner);
			} else {
				fprintf(stderr, "  task %p parked on mutex %p (held by a non-fiber task)\\n",
					(void *)f, (void *)m);
			}
		} else {
			fprintf(stderr, "  task %p parked on io (fd %d)\\n",
				(void *)f, (int)(intptr_t)f->park_obj);
		}
	}
}
// Commit-point check: a non-fiber thread is about to condvar-wait forever
// (future mutex held). Fire when the runtime is fully idle with parked
// fibers; otherwise sleep-and-reverify catches wakes mid-delivery.
static void __nomen_deadlock_check(const char *site) {
	if (__nomen_current_fiber) return;
	int parked = 0;
	pthread_mutex_lock(&__nomen_pool_mu);
	if (__nomen_deadlock_fired) {
		pthread_mutex_unlock(&__nomen_pool_mu);
		return;
	}
	if (__nomen_pool_head || __nomen_pool_busy ||
	    !__nomen_deadlock_stuck_locked(&parked) || parked == 0) {
		pthread_mutex_unlock(&__nomen_pool_mu);
		return;
	}
	// Re-verify lock-free after a short sleep: a just-delivered wake
	// resolves in microseconds; a real deadlock is unchanged.
	pthread_mutex_unlock(&__nomen_pool_mu);
	struct timespec ts = { 0, 10 * 1000 * 1000 };
	nanosleep(&ts, NULL);
	pthread_mutex_lock(&__nomen_pool_mu);
	if (__nomen_deadlock_fired ||
	    __nomen_pool_head || __nomen_pool_busy ||
	    !__nomen_deadlock_stuck_locked(&parked) || parked == 0) {
		pthread_mutex_unlock(&__nomen_pool_mu);
		return;
	}
	__nomen_deadlock_fired = 1;
	// Hold fq_mu for the registry walk: a fiber woken between the verify
	// and the dump flips to READY under this lock, and the dump's PARKED
	// filter skips it.
	pthread_mutex_lock(&__nomen_fq_mu);
	__nomen_deadlock_dump(site);
	pthread_mutex_unlock(&__nomen_fq_mu);
	pthread_mutex_unlock(&__nomen_pool_mu);
	// The future's mutex stays held (the caller's); nothing in the atexit
	// chain needs it.
	exit(2);
}
// Worker-side check: called from the idle worker's wait loop with the pool
// mutex held. Returns 1 when the pool state changed while the mutex was
// released for the re-verify sleep, so the caller re-runs its wait
// predicate instead of condvar-waiting past a lost signal.
static int __nomen_deadlock_check_worker(void) {
	if (__nomen_block_waiters == 0) return 0;
	if (__nomen_pool_head || __nomen_pool_busy || __nomen_deadlock_fired) return 0;
	int parked = 0;
	if (!__nomen_deadlock_stuck_locked(&parked) || parked == 0) return 0;
	// Same re-verify discipline as the commit-point check. The pool mutex
	// is released for the sleep so a real waker can proceed.
	pthread_mutex_unlock(&__nomen_pool_mu);
	struct timespec ts = { 0, 10 * 1000 * 1000 };
	nanosleep(&ts, NULL);
	pthread_mutex_lock(&__nomen_pool_mu);
	if (__nomen_block_waiters == 0) return 1;
	if (__nomen_pool_head || __nomen_pool_busy || __nomen_pool_quitting ||
	    __nomen_deadlock_fired) {
		return 1;
	}
	if (!__nomen_deadlock_stuck_locked(&parked) || parked == 0) return 0;
	__nomen_deadlock_fired = 1;
	// Hold fq_mu for the registry walk (see the commit-point check).
	pthread_mutex_lock(&__nomen_fq_mu);
	__nomen_deadlock_dump("idle worker");
	pthread_mutex_unlock(&__nomen_fq_mu);
	pthread_mutex_unlock(&__nomen_pool_mu);
	exit(2);
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

	// Trampoline: closure body (the code receives the closure itself; the
	// args struct rides in env — CLOSURE_PLAN Phase 3a). Static — only used
	// within the companion; the pool worker dispatches through the
	// descriptor.
	tramp_c += `static void ${tramp_name}(struct nomen_closure *_c) {\n`;
	tramp_c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)_c->env;\n`;
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
	tramp_c += `\t__nomen_future_release(a->future);\n`; // closure disposed at the last release
	tramp_c += `}\n`;
	// Static descriptor template; every spawn copies it into a heap
	// descriptor owning its env (the future's last release disposes it).
	const desc_name = `__nomen_spawn_${id}_descriptor`;
	tramp_c += `static struct nomen_closure ${desc_name} = { (void *)${tramp_name}, NULL, 0, NULL };\n`;

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
		tramp_c += `void **__nomen_nursery_futures, int *__nomen_nursery_count, int *__nomen_nursery_cap`;
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
	// The task closure: heap copy of the site's descriptor with the args
	// struct as env; owned by the future (disposed at the last release).
	tramp_c += `\tstruct nomen_closure *c = (struct nomen_closure *)malloc(sizeof(struct nomen_closure));\n`;
	tramp_c += `\t*c = ${desc_name};\n`;
	tramp_c += `\tc->env = a;\n`;
	tramp_c += `\tc->owned = 1;\n`;
	tramp_c += `\tf->owner_args = c;\n`;
	tramp_c += `\tf->fiber_waiters = NULL;\n`;
	tramp_c += `\tf->owning_fiber = 0;\n`;
	tramp_c += `\t__nomen_pool_submit(c);\n`;
	if (nursery_id !== undefined) {
		tramp_c += `\t__nomen_nursery_track(__nomen_nursery_futures, __nomen_nursery_count, __nomen_nursery_cap, f);\n`;
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

	// When inside a nursery, three extra trailing args carry the ADDRESSES of
	// the nursery's per-invocation tracking slots (futures storage, count,
	// capacity — on the caller's stack). They occupy the last three arg slots.
	const nursery_extra = nursery_off ? 3 : 0;

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
			// Addresses of the nursery's tracking slots: futures storage (the
			// helper reallocs and writes back through it), count, capacity.
			status.code += `add x0, x29, #${nursery_off.futures_off}\n`;
			status.code += `str x0, [x29, #${args_base + (total_arg_slots - 3) * 8}]\n`;
			status.code += `add x0, x29, #${nursery_off.count_off}\n`;
			status.code += `str x0, [x29, #${args_base + (total_arg_slots - 2) * 8}]\n`;
			status.code += `add x0, x29, #${nursery_off.cap_off}\n`;
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
 * Build a `Thread(fn(args)).detach()` call — the daemon form (ASYNC.md,
 * "Daemon tasks"). Mirrors the C backend's build_detached_spawn_node: the
 * trampoline lives in the companion C (no future, no result slot, no
 * cancel flag, no nursery tracking — it frees its own args), and
 * `__nomen_task_detach` launches it on a dedicated detached pthread. The
 * asm stages the arguments and calls the submit helper, which returns NULL
 * (there is no Task).
 */
export function build_detached_spawn_node(node: SpawnNode, status: BuildStatus): void {
	const call = node.call;
	const func_name = c_function_name(emission_label(call.resolved_function ?? call));
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	ensure_concurrency_runtime_a64(status);

	const struct_name = `__nomen_detach_${id}_args`;
	const tramp_name = `__nomen_detach_${id}_trampoline`;
	const submit_name = `nomen_detach_${id}_submit`;

	const arg_c_types: string[] = [];
	for (let i = 0; i < call.params.length; i++) {
		const arg_type = type_from_value_node(call.params[i]);
		const mono_name = mono_type_name(arg_type);
		const is_class = !!status.structs.find((s) => s.name === mono_name && s.is_class);
		const is_trait = !!status.traits.find((t) => t.name === mono_name);
		arg_c_types.push(is_class || is_trait ? `struct ${mono_name} *` : `${c_type(mono_name)}`);
	}

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

	let tramp_c = `// --- detach site ${id} trampoline ---\n`;
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
	tramp_c += `};\n`;
	tramp_c += `static void ${tramp_name}(struct nomen_closure *_c) {\n`;
	tramp_c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)_c->env;\n`;
	tramp_c += `\t__nomen_current_cancel_flag = NULL;\n`;
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
	tramp_c += `\t__nomen_current_cancel_flag = NULL;\n`;
	tramp_c += `}\n`;
	// Static descriptor template; every detach copies it into a heap
	// descriptor owning its env (the detached runner disposes it).
	const desc_name = `__nomen_detach_${id}_descriptor`;
	tramp_c += `static struct nomen_closure ${desc_name} = { (void *)${tramp_name}, NULL, 0, NULL };\n`;

	// Submit helper: allocates the args struct and hands it to the detached
	// launcher. Fat-string params ride the 16-byte by-value pair (see the
	// spawn submit helper).
	tramp_c += `void *${submit_name}(`;
	for (let i = 0; i < arg_c_types.length; i++) {
		if (i > 0) tramp_c += ", ";
		tramp_c += `${arg_c_types[i]} arg${i}`;
	}
	tramp_c += `) {\n`;
	tramp_c += `\tstruct ${struct_name} *a = (struct ${struct_name} *)malloc(sizeof(struct ${struct_name}));\n`;
	for (let i = 0; i < arg_c_types.length; i++) {
		tramp_c += `\ta->arg${i} = arg${i};\n`;
	}
	// The task closure: heap copy of the site's descriptor with the args
	// struct as env; the detached runner disposes it after the call.
	tramp_c += `\tstruct nomen_closure *c = (struct nomen_closure *)malloc(sizeof(struct nomen_closure));\n`;
	tramp_c += `\t*c = ${desc_name};\n`;
	tramp_c += `\tc->env = a;\n`;
	tramp_c += `\tc->owned = 1;\n`;
	tramp_c += `\t__nomen_task_detach(c);\n`;
	tramp_c += `\treturn (void *)0;\n`;
	tramp_c += `}\n`;

	if (!status.file_scope_c) status.file_scope_c = "";
	status.file_scope_c += tramp_c;

	// --- Emit assembly: build arg registers and call the submit helper ---
	// Mirrors the spawn site minus the nursery extras (a daemon is never
	// nursery-tracked).
	status.code += `// detach site ${id}\n`;

	const fat_string_args = call.params.map(spawn_arg_is_string);
	const arg_slot: number[] = [];
	let total_arg_slots = 0;
	for (let i = 0; i < call.params.length; i++) {
		arg_slot.push(total_arg_slots);
		total_arg_slots += fat_string_args[i] ? 2 : 1;
	}

	if (total_arg_slots === 0) {
		status.code += `bl _${submit_name}\n`;
	} else {
		const args_base = allocate_stack_space(status, total_arg_slots * 8, 16);
		for (let i = 0; i < call.params.length; i++) {
			status.code += `// Build arg${i}\n`;
			build_node(call.params[i], status);
			if (!status.code.endsWith("\n")) status.code += "\n";
			status.code += `str x0, [x29, #${args_base + arg_slot[i] * 8}]\n`;
			if (fat_string_args[i]) {
				status.code += `str x1, [x29, #${args_base + (arg_slot[i] + 1) * 8}]\n`;
			}
		}
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
	// x0 = NULL — a daemon yields no Task.
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
