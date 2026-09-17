import emission_label from "../build_common/emission_label.ts";
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
// _XOPEN_SOURCE gates ucontext on macOS — needed by the fiber runtime
// (FIBER_HEADER, appended after this block). Normally defined at the top of
// main.m's preamble (build_root_node); guarded here for headers included in
// isolation.
#ifndef _XOPEN_SOURCE
#define _XOPEN_SOURCE 600
#endif
#include <pthread.h>
#include <time.h>
static __thread unsigned long long *__nomen_current_cancel_flag = NULL;
// Fiber runtime (ASYNC_PLAN.md Phase 1). The pool and the fiber scheduler
// share one header text: this block owns the future machinery and declares
// the fiber seam; FIBER_HEADER (appended immediately after) defines the
// scheduler. A worker drains runnable fibers between pool tasks, so a
// parked fiber frees its worker instead of blocking it. Only pointers to
// struct nomen_fiber appear here — the full type lives in FIBER_HEADER.
struct nomen_fiber;
static __thread struct nomen_fiber *__nomen_current_fiber = NULL;
static struct nomen_fiber *__nomen_fiber_try_pop(void);
static int __nomen_fiber_pending(void);
static void __nomen_fiber_run_here(struct nomen_fiber *f);
static void __nomen_pool_ensure(void);
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
// Fiber seam (defined in FIBER_HEADER, appended after this block). Declared
// here — after struct nomen_future is complete — so the prototypes bind to
// the file-scope type.
static void __nomen_fiber_schedule(struct nomen_fiber *f);
static void __nomen_fiber_park_on_future(struct nomen_future *f);
static void __nomen_fiber_wake_waiters(struct nomen_fiber *w);
static void __nomen_fiber_coop_drain(void);
// Tentative; the fiber header defines it with an initializer.
static int __nomen_fiber_coop;
static void __nomen_future_wait(struct nomen_future *f) {
	// Inside a fiber: park the fiber instead of blocking the worker thread.
	// The park happens under the future's mutex (park-before-signal), so a
	// concurrent completion either sees us on fiber_waiters and schedules
	// us, or is already done and we return immediately.
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
// generated trampolines (and future-release paths) instead of the inline
// done-signaling sequence, so fiber waiters rejoin the scheduler. The
// waiter list walk lives in FIBER_HEADER (full nomen_fiber type).
static void __nomen_future_complete(struct nomen_future *f) {
	pthread_mutex_lock(&f->mu);
	f->done = 1;
	struct nomen_fiber *w = f->fiber_waiters;
	f->fiber_waiters = NULL;
	pthread_cond_broadcast(&f->cv);
	pthread_mutex_unlock(&f->mu);
	if (w) __nomen_fiber_wake_waiters(w);
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
static void __nomen_pool_ensure(void) {
	if (__nomen_pool_init) return;
	__nomen_pool_init = 1;
	__nomen_pool_workers = (pthread_t *)malloc(sizeof(pthread_t) * ECHO_POOL_MAX_SIZE);
	for (int i = 0; i < __nomen_pool_size; i++) {
		pthread_create(&__nomen_pool_workers[__nomen_pool_nworkers], NULL, __nomen_pool_worker, NULL);
		__nomen_pool_nworkers++;
	}
	atexit(__nomen_pool_shutdown);
}
static void __nomen_pool_submit(void (*fn)(void *), void *arg) {
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
// Race-mode helpers: used by async(mode: race) to wait until any one future
// in a nursery completes (or the deadline expires). Returns 1 if any future
// is done, 0 if the deadline hit. Polls every 1ms — the latency/cost
// tradeoff favors simplicity over a signaling mechanism.
static void __nomen_future_cancel(struct nomen_future *f) {
	if (f->cancel_flag) *(f->cancel_flag) = 1;
	// A parked fiber is not running, so the flag alone would never be
	// observed — requeue any fiber waiting on this future so it resumes and
	// sees the cancellation at its next checkpoint. (The C backend's pool
	// text forward-declares __nomen_fiber_wake_waiters.)
	pthread_mutex_lock(&f->mu);
	struct nomen_fiber *w = f->fiber_waiters;
	f->fiber_waiters = NULL;
	pthread_mutex_unlock(&f->mu);
	if (w) __nomen_fiber_wake_waiters(w);
	// The fiber that owns this task may be parked on a primitive waitq
	// (Channel.receive); schedule it so it resumes and observes the flag.
	// schedule() only queues PARKED fibers, so a double wake is harmless.
	if (f->owning_fiber) __nomen_fiber_schedule(f->owning_fiber);
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
 * Append the concurrency runtime (pool + fiber) to this build's header sink,
 * once per build. Every sink that emits a trampoline, a nursery join, or a
 * primitive whose raw body branches into the runtime calls this. The flags —
 * not a header-content search — make it idempotent: a nested-function build
 * clears status.headers mid-build, so a marker check would append twice.
 */
export function ensure_concurrency_runtime(status: BuildStatus): void {
	if (status.pool_runtime_emitted && status.fiber_runtime_emitted) return;
	if (!status.pool_runtime_emitted) {
		status.headers += POOL_HEADER;
		status.pool_runtime_emitted = true;
	}
	if (!status.fiber_runtime_emitted) {
		status.headers += FIBER_HEADER;
		status.fiber_runtime_emitted = true;
	}
}

export const FIBER_HEADER = `
#include <ucontext.h>
#include <stdint.h>
#include <stdlib.h>
#define NOMEN_FIBER_STACK_SIZE (64 * 1024)
enum { NOMEN_FIBER_READY, NOMEN_FIBER_RUNNING, NOMEN_FIBER_PARKED, NOMEN_FIBER_DONE };
typedef ucontext_t nomen_fiber_ctx;
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
static int __nomen_fiber_pending(void) {
	pthread_mutex_lock(&__nomen_fq_mu);
	int pending = __nomen_fq_head != NULL;
	pthread_mutex_unlock(&__nomen_fq_mu);
	return pending;
}
static void __nomen_fiber_schedule(struct nomen_fiber *f) {
	// Only a parked fiber is queued: spawn/yield/park set PARKED first, and
	// a second wake (cancel racing a send) then sees READY and is a no-op.
	// This also makes stale waitq entries harmless.
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
// Suspend the current fiber: its continuation lands in f->ctx and the
// runner's frame resumes. The state is set by the caller BEFORE suspending
// (PARKED under the future's mutex for park-before-signal; DONE in the
// entry trampoline; the runner frees DONE fibers when it observes them).
static void __nomen_fiber_pause(void) {
	struct nomen_fiber *self = __nomen_current_fiber;
	swapcontext(&self->ctx, __nomen_fiber_ret);
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
// Park the current fiber until the future completes. Called from
// __nomen_future_wait with __nomen_current_fiber set. The state flip to
// PARKED happens under the future's mutex — park-before-signal — so a
// concurrent __nomen_future_complete either has us on fiber_waiters (and
// schedules us) or has already set done (we never park).
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
static void __nomen_fiber_entry(uint32_t lo, uint32_t hi);
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
	swapcontext(&ret, &f->ctx);
	__nomen_current_fiber = NULL;
	if (f->state == NOMEN_FIBER_DONE) {
		// Safe: we are back on this thread's own stack; the fiber's is dead.
		free(f->stack);
		free(f);
	}
	pthread_mutex_lock(&__nomen_pool_mu);
	__nomen_pool_busy--;
	pthread_mutex_unlock(&__nomen_pool_mu);
}
static void __nomen_fiber_entry(uint32_t lo, uint32_t hi) {
	struct nomen_fiber *self = (struct nomen_fiber *)(((uintptr_t)hi << 32) | (uintptr_t)lo);
	__nomen_current_fiber = self;
	self->fn(self->args);
	self->state = NOMEN_FIBER_DONE;
	__nomen_fiber_pause();
}
// Park the current fiber on a primitive's wait queue. The caller holds the
// primitive's mutex (*mu) and has just checked its predicate false. The
// fiber registers on *head, releases the mutex, parks, and on resume
// re-acquires the mutex and unlinks itself (the waker may have cleared the
// whole list already). Returns 0 when the fiber has been cancelled (it
// resumes from the park to observe that — the cooperative contract), 1
// otherwise. Outside a fiber it blocks on the condvar exactly as before.
static int __nomen_fiber_waitq_park(struct nomen_fiber **head, void *mu, void *cv) {
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
// Wake every fiber parked on a wait queue. The caller holds the primitive's
// mutex (the same one the parkers released). Schedule() is idempotent, so a
// fiber already woken by cancellation is simply skipped.
static void __nomen_fiber_waitq_wake(struct nomen_fiber **head) {
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
static void __nomen_fiber_yield(void);
// Lock a pthread mutex. In cooperative mode a fiber try-locks and yields
// (the holder runs on this thread); otherwise it blocks as before — a task
// blocked on a contended mutex in the threaded model is not parked (see
// FOLLOWUP.md).
static void __nomen_mutex_lock(void *mu) {
	if (__nomen_current_fiber && __nomen_fiber_coop) {
		while (pthread_mutex_trylock((pthread_mutex_t *)mu) != 0) {
			__nomen_fiber_yield();
		}
		return;
	}
	pthread_mutex_lock((pthread_mutex_t *)mu);
}
static void __nomen_fiber_yield(void) {
	struct nomen_fiber *self = __nomen_current_fiber;
	if (!self) return;
	self->state = NOMEN_FIBER_PARKED;
	__nomen_fiber_schedule(self);
	__nomen_fiber_pause();
}
// Run every currently-runnable fiber to its next suspension. Reentrancy is
// guarded: a drain already in progress lets its own loop pick up fibers
// scheduled meanwhile (a fiber's own wait never drains — the future hook
// only fires outside a fiber).
static int __nomen_coop_atexit = 0;
static void __nomen_fiber_drain_all(void) {
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
static int __nomen_fiber_is_active(void) {
	return __nomen_current_fiber != NULL;
}
static void __nomen_fiber_set_cooperative(int on) {
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
	// Initialize and make the context IN PLACE: uc_mcontext may point into
	// the ucontext itself, so copying one by value would dangle it.
	getcontext(&f->ctx);
	if (stack) {
		f->ctx.uc_stack.ss_sp = stack;
		f->ctx.uc_stack.ss_size = stack_size;
	} else {
		f->stack = malloc(NOMEN_FIBER_STACK_SIZE);
		f->ctx.uc_stack.ss_sp = f->stack;
		f->ctx.uc_stack.ss_size = NOMEN_FIBER_STACK_SIZE;
	}
	f->ctx.uc_link = NULL;
	uintptr_t fp = (uintptr_t)f;
	makecontext(&f->ctx, (void (*)(void))__nomen_fiber_entry, 2, (uint32_t)fp, (uint32_t)(fp >> 32));
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
static void __nomen_io_shutdown(void) {
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
static int __nomen_io_wait(int fd, int want_write) {
	if (__nomen_current_cancel_flag && *__nomen_current_cancel_flag) return 0;
	if (__nomen_current_fiber) {
		struct nomen_fiber *self = __nomen_current_fiber;
		struct nomen_io_waiter *w = __nomen_io_register(fd, want_write, self);
		self->state = NOMEN_FIBER_PARKED;
		__nomen_fiber_pause();
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

static void __nomen_fiber_spawn(void (*fn)(void *), void *args, struct nomen_future *future) {
	__nomen_fiber_spawn_common(fn, args, future, NULL, 0);
}
static void __nomen_fiber_spawn_on(void (*fn)(void *), void *args, struct nomen_future *future, void *stack, size_t stack_size) {
	__nomen_fiber_spawn_common(fn, args, future, stack, stack_size);
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
	const func_name = c_function_name(emission_label(call.resolved_function ?? call));
	const id = status.spawn_counter ?? 0;
	status.spawn_counter = id + 1;

	// Emit pool infrastructure on first spawn (file scope, deduped).
	ensure_concurrency_runtime(status);

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
	header += `\t__nomen_future_complete(a->future);\n`;
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
	status.code += `\t_future->fiber_waiters = NULL;\n`;
	status.code += `\t_future->owning_fiber = NULL;\n`;
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
