import { mono_type_name } from "../build_common/mono_name.ts";
import { is_built_in_type } from "../built_in_types.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import Type from "../nodes/Type.ts";
import type BuildStatus from "./BuildStatus.ts";
import { globalize_runtime, runtime_declarations } from "./runtime_split.ts";
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
#include <stdio.h>
#include <time.h>
// The spawn runtime speaks the closure descriptor ABI (CLOSURE.md):
// a submitted task IS a "struct nomen_closure *" whose code receives the
// closure itself ("void (*)(struct nomen_closure *)" — env is reachable
// through it). The preamble (build_root_node) already defines the struct in
// the user TU's headers; this guarded copy keeps the runtime text
// self-contained (split builds globalize it into a TU of its own).
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
static void __nomen_closure_dispose(struct nomen_closure *c) {
	if (!c || !c->owned) return;
	if (c->destroy_env) c->destroy_env(c->env);
	free(c->env);
	free(c);
}
// The library must-start contract (Thread/Fiber #destroy): a spawn value
// that is destroyed without ever being started is a programming error —
// report why and abort. Reached from the generated #destroy bodies on both
// backends (non-static on aarch64, where raw asm branches into it).
void __nomen_spawn_must_start_abort(void) {
	fprintf(stderr, "error: a Thread(fn(args)) / Fiber(fn(args)) value was never started - append .start() (or .detach()) or pass it to a nursery's .start()\\n");
	abort();
}
static __thread unsigned long long *__nomen_current_cancel_flag = NULL;
// Fiber runtime (ASYNC.md Phase 1). The pool and the fiber scheduler
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
	// 1 when the result slot holds a FAT string (set at construction, which
	// knows the wrapped call's return type). The last release frees an
	// unconsumed string buffer from the cell: result() zeroes the cell when
	// it moves the value out, and Task's #destroy zeroes after its own
	// free, so a non-NULL ptr at the last release means "never consumed".
	// Appended LAST: raw aarch64 bodies read refs/result_slot/owner_args at
	// fixed offsets (#116/#128/#136), which must not shift.
	int slot_fat;
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
// Non-fiber threads currently committed to a blocking wait (the condvar
// branches below, guarded by __nomen_pool_mu). The worker-side deadlock
// check only fires when this is nonzero: a non-fiber thread NOT blocked
// here may be mid-statement about to send/wake — invisible to the runtime —
// so firing on an otherwise-idle runtime would be unsound.
static int __nomen_block_waiters = 0;
// Defined (initialized) in the pool section below; the future waits
// publish __nomen_block_waiters under this mutex. Tentative here, single
// initialized definition there.
static pthread_mutex_t __nomen_pool_mu;
static pthread_cond_t __nomen_pool_cv;
// Deadlock detector (Go's "all goroutines are asleep" model); defined in
// FIBER_HEADER. The commit-point check runs on a non-fiber thread just
// before an indefinite condvar wait; the worker check runs from an idle
// worker's wait loop (pool mutex held) when some thread is blocked.
static void __nomen_deadlock_check(const char *site);
static int __nomen_deadlock_check_worker(void);
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
		// Block-forever commit: publish the waiter (the worker-side check
		// needs it), then let the detector judge the whole runtime. The
		// check itself may exit(2) with a wait-graph dump.
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
			// Indefinite wait — same commit-point detection as
			// __nomen_future_wait. Finite deadlines self-wake and are
			// skipped on purpose: a timeout can still rescue the graph.
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
		// An unconsumed fat-string result: free the buffer the trampoline
		// stored (race-mode and fire-and-forget tasks never hand it to a
		// consumer). Every consumer path zeroes the cell first — result()
		// on move-out, Task's #destroy after its own free — so a non-NULL
		// ptr here is unambiguous and the free happens exactly once.
		if (f->slot_fat && f->result_slot) {
			unsigned long long *_s = (unsigned long long *)f->result_slot;
			if (_s[0]) {
				free((void *)_s[0]);
				_s[0] = 0;
				_s[1] = 0;
			}
		}
		free(f->result_slot);
		// The task closure is owned by the future: disposing it here (the
		// last release, ordered after every use — trampoline, Task destroy,
		// nursery join) instead of inside the trampoline avoids the worker's
		// free racing the submitting thread's post-submit allocations, which
		// corrupted the freshly-allocated Task on macOS's nano allocator
		// (intermittent SIGSEGV in Task.result).
		__nomen_closure_dispose((struct nomen_closure *)f->owner_args);
		free(f);
	}
}
struct nomen_pool_task {
	struct nomen_closure *task;
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
			// Every thread is accounted for: the queue is empty, this worker
			// is idle, and if a non-fiber thread is committed to a blocking
			// wait (__nomen_block_waiters), only a parked fiber could make
			// progress — the detector judges whether anything ever will. A
			// 1 return means the pool state moved while the detector slept;
			// re-run the predicate instead of condvar-waiting past the
			// signal that arrived during the release.
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
static void __nomen_pool_submit(struct nomen_closure *task) {
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
// Non-blocking completion peek (Task.is_done): 1 once the future's task has
// finished, 0 while it may still be running (and for a NULL — a consumed or
// never-launched handle).
static int __nomen_future_is_done(struct nomen_future *f) {
	if (!f) return 0;
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
// Register a future with a nursery's growable list (ASYNC.md Phase 3:
// the fixed 65536-entry array was both a ceiling and a 512 KB allocation for
// tiny blocks). "slots" points at the list's storage slot (which starts NULL
// and grows by realloc — the join loop and any passed Nursery see updates
// through the same slot), "count" is the registered count, "cap" the
// capacity. Shared by all four registration sites: direct Thread/Fiber
// spawns (per-backend) and the Nursery escape hatch (through the struct's
// tracking pointers). Not thread-safe across concurrent spawns into ONE
// nursery — the direct "count++" it replaces was not either.
static void __nomen_nursery_track(void **slots, int *count, int *cap, struct nomen_future *f) {
	if (*count >= *cap) {
		*cap = *cap ? *cap * 2 : 16;
		*slots = realloc(*slots, (size_t)*cap * sizeof(struct nomen_future *));
	}
	((struct nomen_future **)*slots)[(*count)++] = f;
}
// ---- detached daemon tasks: the Thread(fn(args)).detach() form
// (ASYNC.md, "Daemon tasks") ----
// The std::thread::spawn contract: the call runs on its OWN pthread —
// never a pool worker — and nobody joins it. Process exit kills it
// mid-execution BY DESIGN (a process-lifetime service does not block
// shutdown); the daemon owns its own shutdown (a stop channel or flag).
// No future, no handle, no cancellation: Task.current_cancelled() is
// always false inside, and the pool / shutdown machinery is untouched.
// The task closure is disposed here — by the one thread that ran it —
// never inside the generated body (that was a double free before the
// closure ABI: the body freed the args struct AND this runner freed it).
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
		// Best effort, consistent with the pool's pthread_create handling:
		// free what the daemon would have owned and say why it is gone.
		__nomen_closure_dispose(task);
		free(d);
		fprintf(stderr, "warning: Thread(fn(args)).detach() could not start a thread\\n");
	}
	pthread_attr_destroy(&attr);
}
`;
/**
 * Append the concurrency runtime to this build, once per build. Every sink
 * that emits a trampoline, a nursery join, or a primitive whose raw body
 * branches into the runtime calls this. The flags — not a header-content
 * search — make it idempotent: a nested-function build clears status.headers
 * mid-build, so a marker check would append twice.
 *
 * Single-TU builds ("all") paste the static definitions into the TU's
 * headers exactly as before. Split builds share ONE runtime copy: the
 * system build declares the runtime in its headers (system.h) and defines
 * it with external linkage (accumulated onto status.c_runtime_defs, which
 * build() flushes to file scope in the system TU's code); the user build
 * emits only the declarations and links against system.o. Duplicate copies
 * of the runtime state — one per TU — would fork the pool queues, the
 * fiber scheduler's TLS, and the netpoller slots, so a library body could
 * run against a different runtime copy than the user fibers (see
 * FOLLOWUP.md).
 */
export function ensure_concurrency_runtime(status: BuildStatus): void {
	// Every caller that pulls the runtime in also makes fiber/pool exit
	// hooks (main's drain_all / io_shutdown / pool_shutdown) meaningful —
	// including split-build user TUs, whose concurrency TYPES live in the
	// system TU and so never set the flags themselves.
	status.used_fibers = true;
	if (status.pool_runtime_emitted && status.fiber_runtime_emitted) return;
	const mode = status.emit_mode ?? "all";
	if (mode !== "all") {
		if (!status.pool_runtime_emitted) {
			// The system build declares the runtime in its headers (system.h,
			// which every user TU includes) and defines it with external
			// linkage (accumulated onto status.c_runtime_defs, flushed to
			// file scope in the system TU's code by build()). The user build
			// emits nothing — it would duplicate system.h's declarations.
			if (mode === "system") {
				status.headers += runtime_declarations();
				status.c_runtime_defs =
					(status.c_runtime_defs ?? "") + globalize_runtime(POOL_HEADER + FIBER_HEADER);
			}
			status.pool_runtime_emitted = true;
			status.fiber_runtime_emitted = true;
		}
		return;
	}
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
#include <stdio.h>
#include <stddef.h>
#include <stdlib.h>
#define NOMEN_FIBER_STACK_SIZE (64 * 1024)
enum { NOMEN_FIBER_READY, NOMEN_FIBER_RUNNING, NOMEN_FIBER_PARKED, NOMEN_FIBER_DONE };
typedef ucontext_t nomen_fiber_ctx;
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
	// Park diagnostics, read by the deadlock dump: what we are parked on.
	// Set only once the park is fully registered (on the wait list / in the
	// netpoller slots) and cleared on resume — state PARKED with a NULL kind
	// is a transient (yield, mid-registration) and never counted or dumped.
	const char *park_kind;
	void *park_obj;
};
static pthread_mutex_t __nomen_fq_mu = PTHREAD_MUTEX_INITIALIZER;
static struct nomen_fiber *__nomen_fq_head = NULL;
static struct nomen_fiber *__nomen_fq_tail = NULL;
// All live fibers (guarded by __nomen_fq_mu): linked at spawn, unlinked
// when the body returns. The deadlock dump walks this because a parked
// fiber lives on no single list — futures, channels, mutexes, and the
// netpoller each hold their own waiters.
static struct nomen_fiber *__nomen_fiber_all = NULL;
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
	self->park_kind = "future";
	self->park_obj = f;
	self->state = NOMEN_FIBER_PARKED;
	pthread_mutex_unlock(&f->mu);
	__nomen_fiber_pause();
	self->park_kind = NULL;
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
		// Unlink from the all-fibers registry before freeing.
		pthread_mutex_lock(&__nomen_fq_mu);
		struct nomen_fiber **all = &__nomen_fiber_all;
		while (*all && *all != f) all = &(*all)->all_next;
		if (*all) *all = f->all_next;
		pthread_mutex_unlock(&__nomen_fq_mu);
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
	((void (*)(struct nomen_closure *))self->task->code)(self->task);
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
		// A plain thread task: block in bounded slices so a cancellation it
		// cannot otherwise see (the producer was cancelled before sending)
		// still returns the zero value — the cooperative contract. An
		// unbounded cond_wait here would hold the task's future past the
		// nursery join's grace period while the block exit tears the
		// channel down under the still-blocked task.
		if (__nomen_current_cancel_flag && *__nomen_current_cancel_flag) return 0;
		struct timespec ts;
		clock_gettime(CLOCK_REALTIME, &ts);
		ts.tv_nsec += 100 * 1000 * 1000;
		if (ts.tv_nsec >= 1000000000L) {
			ts.tv_sec += 1;
			ts.tv_nsec -= 1000000000L;
		}
		pthread_cond_timedwait((pthread_cond_t *)cv, (pthread_mutex_t *)mu, &ts);
		return __nomen_current_cancel_flag && *__nomen_current_cancel_flag ? 0 : 1;
	}
	self->wait_next = *head;
	*head = self;
	self->park_head = head;
	// The kind is inferred from the shape of the call site: the only
	// primitive waitqs are Channel receive (parked under its not_empty_cv)
	// and Mutex lock (cv unused, NULL here). Set before the PARKED flip so
	// the deadlock dump never sees a parked fiber without one.
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
// Nomen Mutex layout — one allocation handed to the Mutex class raw bodies
// (which call the helpers below; the class never dereferences the handle
// itself). wmu guards the fiber wait list and is deliberately NOT the lock:
// a holder may park mid-critical-section, and a waiter must be able to
// register on the wait list without blocking behind it. Defined under a
// guard because the runtime header and the Mutex class body compile into
// the same TU in single-TU builds.
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
static void *__nomen_mutex_create(void) {
	struct nomen_mutex *m = (struct nomen_mutex *)malloc(sizeof(struct nomen_mutex));
	pthread_mutex_init(&m->mu, NULL);
	pthread_mutex_init(&m->wmu, NULL);
	m->waiters = NULL;
	m->owner = NULL;
	return m;
}
// Unlock and wake fibers parked on the mutex (Mutex.unlock).
static void __nomen_mutex_unlock_wake(void *mp) {
	struct nomen_mutex *m = (struct nomen_mutex *)mp;
	m->owner = NULL;
	pthread_mutex_unlock(&m->mu);
	pthread_mutex_lock(&m->wmu);
	__nomen_fiber_waitq_wake(&m->waiters);
	pthread_mutex_unlock(&m->wmu);
}
// Destroy and free the Mutex handle (Mutex.#destroy).
static void __nomen_mutex_dispose(void *mp) {
	struct nomen_mutex *m = (struct nomen_mutex *)mp;
	pthread_mutex_destroy(&m->mu);
	pthread_mutex_destroy(&m->wmu);
	free(m);
}
// Lock a Nomen mutex. In cooperative mode a fiber try-locks and yields (the
// holder runs on this thread). In the threaded model a fiber PARKS on the
// mutex's wait list instead of blocking its worker; unlock wakes the list.
// Cancellation while waiting does not return without the lock — the
// caller's matching unlock would be unsound — so a cancelled waiter keeps
// waiting (parked, not spinning) and observes the cancel flag at its next
// checkpoint after acquiring. Non-fibers block on the pthread lock exactly
// as before.
static void __nomen_mutex_lock(void *mp) {
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
			// Re-check under the guard: the holder may have unlocked and
			// woken (and cleared) the wait list before we registered.
			if (pthread_mutex_trylock(&m->mu) == 0) {
				pthread_mutex_unlock(&m->wmu);
				m->owner = __nomen_current_fiber;
				return;
			}
			// The cv argument is unused here: waitq_park's non-fiber
			// branch is unreachable (a fiber is parked on this thread).
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
static void __nomen_fiber_yield(void) {
	struct nomen_fiber *self = __nomen_current_fiber;
	if (!self) return;
	// A yield is transient (we requeue ourselves immediately); the park
	// kind must not present this as a real park to the deadlock detector.
	self->park_kind = NULL;
	self->park_obj = NULL;
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

// ---- async I/O: netpoller (ASYNC.md Phase 3) ----
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
		// Park BEFORE registering: the poller can fire as soon as the fd is
		// in the set (it may already be ready), and a wake delivered while
		// state is still RUNNING would be dropped by schedule()'s guard —
		// a lost wake with the event already consumed. The park kind is set
		// only AFTER the registration is live: PARKED with a NULL kind is
		// the transient the deadlock detector skips.
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

static void __nomen_fiber_spawn(struct nomen_closure *task, struct nomen_future *future) {
	__nomen_fiber_spawn_common(task, future, NULL, 0);
}
static void __nomen_fiber_spawn_on(struct nomen_closure *task, struct nomen_future *future, void *stack, size_t stack_size) {
	__nomen_fiber_spawn_common(task, future, stack, stack_size);
}

// ---- deadlock detection ("all tasks are asleep", Go's model) ----
// Trigger points are the moments a thread COMMITS to blocking forever: the
// indefinite condvar branches of __nomen_future_wait / __nomen_future_timedwait
// (nursery joins, Task.result/wait on a raw thread), and an idle pool
// worker's wait loop when some thread is so committed. A non-fiber thread
// NOT committed to a wait may be mid-statement about to send or wake — it
// is invisible to this runtime — so the worker-side check refuses to fire
// unless __nomen_block_waiters says someone is blocked. Raw blocking calls
// outside these primitives (blocking FFI, a Thread-model task parked on a
// condvar) hold no node in the graph — the same blind spot as Go's
// detector, and documented as such.
//
// Stuck means: fiber run queue empty, pool queue empty, no worker busy, no
// fd registered with the netpoller, and at least one fiber parked on
// something (state PARKED with a park kind). Every waker would have to be
// the netpoller (idle), a worker (none busy), or the committed thread
// itself (asleep) — nothing can progress. Both check paths sleep 10 ms and
// re-verify before firing, so transient states (a wake mid-delivery) are
// not misjudged. Known false-positive source: same as the blind spot — a
// program kept alive ONLY by a raw blocking call cannot be distinguished
// from a deadlock; the timing window makes this vanishingly rare in
// practice and Go accepts the identical trade.
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
	// Re-verify lock-free after a short sleep: a just-delivered wake (the
	// netpoller scheduling a fiber, a worker mid-handoff) resolves in
	// microseconds; a real deadlock is unchanged.
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
// mutex held. Fires only when some thread is committed to a blocking wait
// — otherwise a non-fiber thread may be mid-statement, invisible here.
// Returns 1 when the pool state changed while the mutex was released for
// the re-verify sleep, so the caller re-runs its wait predicate instead of
// condvar-waiting past a lost signal.
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
	return spawn_arg_types(call, status).map((t) => {
		const mono_name = mono_type_name(t);
		const is_class = !!status.structs.find((s) => s.name === mono_name && s.is_class);
		const is_trait = !!status.traits.find((t) => t.name === mono_name);
		if (is_class || is_trait) return `struct ${mono_name} *`;
		// A known VALUE struct rides by value and needs the `struct` tag
		// (c_type's bare name is only valid for builtins).
		const is_struct = !!status.structs.find(
			(s) => s.name === mono_name && !s.is_simple_type && !s.is_class,
		);
		if (is_struct) return `struct ${mono_name}`;
		return c_type(mono_name);
	});
}

/**
 * Resolve each spawn argument's TYPE (the callee's declared parameter when
 * resolvable, else the argument's own) — the ownership classification for
 * the task env reads these (CLOSURE.md Phase 3d: the env is an
 * OWNING struct — string args are duplicated at pack and freed by the env
 * destructor; owning value-struct args get `<T>_destroy` on the env's
 * copy).
 */
export function spawn_arg_types(call: FunctionCallNode, status: BuildStatus): Type[] {
	const arg_types: Type[] = [];
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
		arg_types.push(param_type);
	}
	return arg_types;
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

/**
 * Whether any raw `#arch` body under this node
 * references the concurrency runtime (`__nomen_*` symbols — pool, futures,
 * fiber scheduler, nursery tracking, netpoller). The runtime is the
 * LIBRARY's dependency: a method whose raw body drives it pulls it in,
 * keyed on body CONTENT — never on a type name.
 */
function raw_bodies_reference_runtime(node: BaseNode | undefined): boolean {
	if (!node || typeof node !== "object") return false;
	if ((node as { node_type?: string }).node_type === "raw") {
		const raw = (node as { value?: unknown }).value;
		return typeof raw === "string" && raw.includes("__nomen_");
	}
	for (const key of Object.keys(node as unknown as Record<string, unknown>)) {
		if (key === "parent" || key === "scope") continue;
		const v = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(v)) {
			for (const item of v) {
				if (raw_bodies_reference_runtime(item as BaseNode)) return true;
			}
		} else if (v && typeof v === "object" && "node_type" in v) {
			if (raw_bodies_reference_runtime(v as BaseNode)) return true;
		}
	}
	return false;
}

/**
 * Pull the concurrency runtime in when this struct method's raw bodies
 * reference it (deduped by the ensure flags). Replaces the old per-type-name
 * gates (CONCURRENCY_TYPES / the aarch64 Fiber||Thread check): the runtime
 * dependency now belongs to the library code itself.
 */
export function ensure_runtime_for_method(func: FunctionNode, status: BuildStatus): void {
	for (const stmt of func.statements ?? []) {
		if (raw_bodies_reference_runtime(stmt)) {
			ensure_concurrency_runtime(status);
			return;
		}
	}
}
