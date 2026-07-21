#import <Foundation/Foundation.h>
#include <objc/runtime.h>
#include <objc/message.h>
#import <Cocoa/Cocoa.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <regex.h>
#include <pthread.h>

typedef struct Console
{
void *_vt;
} Console;
typedef struct Channel
{
void *_vt;
unsigned long long mu;
unsigned long long not_empty_cv;
unsigned long long head;
unsigned long long tail;
} Channel;
typedef struct Task_uint64
{
void *_vt;
unsigned long long handle;
unsigned char done;
unsigned long long result_slot;
unsigned long long cancel_flag;
unsigned long long future;
} Task_uint64;

unsigned long long __echo_nursery_0_futures[64];
int __echo_nursery_0_count = 0;

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
void __echo_future_wait(struct echo_future *f) {
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
int __echo_future_timedwait(struct echo_future *f, long long deadline_ms) {
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
			pthread_mutex_unlock(&f->mu);
			return 0;
		}
	}
	pthread_mutex_unlock(&f->mu);
	return 1;
}
void __echo_future_release(struct echo_future *f) {
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
pthread_mutex_t __echo_pool_mu = PTHREAD_MUTEX_INITIALIZER;
pthread_cond_t __echo_pool_cv = PTHREAD_COND_INITIALIZER;
struct echo_pool_task *__echo_pool_head = NULL;
struct echo_pool_task *__echo_pool_tail = NULL;
#define ECHO_POOL_DEFAULT_SIZE 4
#define ECHO_POOL_MAX_SIZE 64
int __echo_pool_size = ECHO_POOL_DEFAULT_SIZE;
pthread_t *__echo_pool_workers = NULL;
int __echo_pool_nworkers = 0;
int __echo_pool_busy = 0;
int __echo_pool_init = 0;
int __echo_pool_quitting = 0;
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
void __echo_pool_shutdown(void) {
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
void __echo_pool_submit(void (*fn)(void *), void *arg) {
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
// --- spawn site 1 trampoline ---
void producer(struct Channel *);
struct __echo_spawn_1_args {
	struct Channel * arg0;
	unsigned long long *result_slot;
	unsigned long long *cancel_flag;
	struct echo_future *future;
};
static void __echo_spawn_1_trampoline(void *p) {
	struct __echo_spawn_1_args *a = (struct __echo_spawn_1_args *)p;
	__echo_current_cancel_flag = a->cancel_flag;
	producer(a->arg0);
	__echo_current_cancel_flag = NULL;
	pthread_mutex_lock(&a->future->mu);
	a->future->done = 1;
	pthread_cond_broadcast(&a->future->cv);
	pthread_mutex_unlock(&a->future->mu);
	__echo_future_release(a->future);
	free(a);
}
void *echo_spawn_1_submit(struct Channel * arg0) {
	struct __echo_spawn_1_args *a = (struct __echo_spawn_1_args *)malloc(sizeof(struct __echo_spawn_1_args));
	a->arg0 = arg0;
	a->result_slot = (unsigned long long *)malloc(sizeof(unsigned long long));
	*(a->result_slot) = 0;
	a->cancel_flag = (unsigned long long *)malloc(sizeof(unsigned long long));
	*(a->cancel_flag) = 0;
	struct echo_future *f = (struct echo_future *)malloc(sizeof(struct echo_future));
	pthread_mutex_init(&f->mu, NULL);
	pthread_cond_init(&f->cv, NULL);
	f->done = 0;
	f->refs = 3;
	f->cancel_flag = a->cancel_flag;
	f->result_slot = a->result_slot;
	a->future = f;
	__echo_pool_submit(__echo_spawn_1_trampoline, a);
	__echo_nursery_0_futures[__echo_nursery_0_count++] = (unsigned long long)f;
	struct Task_uint64 *t = (struct Task_uint64 *)malloc(sizeof(struct Task_uint64));
	t->handle = 0;
	t->done = 0;
	t->result_slot = (unsigned long long)a->result_slot;
	t->cancel_flag = (unsigned long long)a->cancel_flag;
	t->future = (unsigned long long)f;
	return t;
}

// Task_uint64_current_cancelled
unsigned char Task_uint64_current_cancelled(void) __asm__("Task_uint64_current_cancelled");
unsigned char Task_uint64_current_cancelled(void)
{
return __echo_current_cancel_flag && *__echo_current_cancel_flag;

}

