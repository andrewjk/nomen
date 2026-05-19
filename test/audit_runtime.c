#include <stdio.h>
#include <stdlib.h>

static long echo_malloc_count = 0;

void *echo_malloc_wrap(unsigned long size) {
	void *ptr = malloc(size);
	echo_malloc_count++;
	return ptr;
}

void echo_free_wrap(void *ptr) {
	free(ptr);
	echo_malloc_count--;
}

void echo_audit_check(void) {
	if (echo_malloc_count != 0) {
		printf("LEAK: %ld allocation(s)\n", echo_malloc_count);
	}
}
