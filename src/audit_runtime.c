#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static long echo_malloc_count = 0;

void *echo_malloc_wrap(unsigned long size) {
	void *ptr = malloc(size);
	echo_malloc_count++;
	return ptr;
}

void *echo_calloc_wrap(unsigned long count, unsigned long size) {
	void *ptr = calloc(count, size);
	echo_malloc_count++;
	return ptr;
}

void *echo_realloc_wrap(void *old_ptr, unsigned long size) {
	if (!old_ptr) {
		echo_malloc_count++;
	}
	void *ptr = realloc(old_ptr, size);
	return ptr;
}

void echo_free_wrap(void *ptr) {
	free(ptr);
	echo_malloc_count--;
}

void *echo_strdup_wrap(const char *s) {
	unsigned long len = strlen(s) + 1;
	void *ptr = malloc(len);
	if (ptr) memcpy(ptr, s, len);
	echo_malloc_count++;
	return ptr;
}

void echo_audit_check(void) {
	if (echo_malloc_count != 0) {
		printf("LEAK: %ld allocation(s)\n", echo_malloc_count);
	}
}
