#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Atomic: worker threads from the pool malloc/free concurrently, and a
// plain `long` would lose updates under that contention (showing up as
// spurious LEAK/negative-count failures in tests that use spawns).
static volatile long nomen_malloc_count = 0;

void *nomen_malloc_wrap(unsigned long size) {
	void *ptr = malloc(size);
	__atomic_add_fetch(&nomen_malloc_count, 1, __ATOMIC_SEQ_CST);
	return ptr;
}

void *nomen_calloc_wrap(unsigned long count, unsigned long size) {
	void *ptr = calloc(count, size);
	__atomic_add_fetch(&nomen_malloc_count, 1, __ATOMIC_SEQ_CST);
	return ptr;
}

void *nomen_realloc_wrap(void *old_ptr, unsigned long size) {
	if (!old_ptr) {
		__atomic_add_fetch(&nomen_malloc_count, 1, __ATOMIC_SEQ_CST);
	}
	void *ptr = realloc(old_ptr, size);
	return ptr;
}

void nomen_free_wrap(void *ptr) {
	if (ptr) {
		free(ptr);
		__atomic_sub_fetch(&nomen_malloc_count, 1, __ATOMIC_SEQ_CST);
	}
}

void *nomen_strdup_wrap(const char *s) {
	unsigned long len = strlen(s) + 1;
	void *ptr = malloc(len);
	if (ptr) memcpy(ptr, s, len);
	__atomic_add_fetch(&nomen_malloc_count, 1, __ATOMIC_SEQ_CST);
	return ptr;
}

void nomen_audit_check(void) {
	long count = __atomic_load_n(&nomen_malloc_count, __ATOMIC_SEQ_CST);
	if (count != 0) {
		printf("LEAK: %ld allocation(s)\n", count);
	}
}
