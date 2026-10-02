#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// The allocation ledger behind `--audit` (`nomen test --audit`,
// `Tester.audit_count`, and the generated harness's per-test attribution).
//
// Every wrapped block carries a 16-byte header (magic, size, state) in front of
// the payload the program sees, so every wrapped free can be matched against a
// LIVE block. The header is the whole point: a bare counter cannot tell a
// correct free from an incorrect one, and both failures it used to absorb are
// ownership bugs the generated code cannot prove away.
//
//   - free of a pointer this runtime never handed out (a pool/BSS/rodata
//     address, a libc allocation, a stale pointer kept across a realloc) used
//     to decrement the counter like any other free. That silently hid the exact
//     failure the allmark aarch64 sanitize runs hit — `free()` of a non-heap
//     address aborting in libmalloc with no audit-level diagnosis — and it let
//     the reported count drift away from the allocator's real state, so a
//     genuine leak count and a phantom one were indistinguishable.
//   - a second free of the SAME block (a double free, or a stale pointer whose
//     memory the allocator already recycled) decremented a second time.
//   - `realloc(p, 0)` frees `p`; the old counter kept it live, so every such
//     call read as one phantom allocation.
//
// A stale free no longer decrements and no longer reaches libc `free` (it may
// not be ours to free at all): it is counted in `nomen_stale_frees` and
// reported by `nomen_audit_check`, so the run fails with a diagnosis instead of
// dying inside the allocator. The allocation count itself is unchanged — one
// increment per wrapped block, one decrement per reclaimed block — so it stays
// exactly as before: the audit test contract.

// Atomic: worker threads from the pool malloc/free concurrently, and a
// plain `long` would lose updates under that contention (showing up as
// spurious LEAK/negative-count failures in tests that use spawns).
static volatile long nomen_malloc_count = 0;

// Frees that did not match a live wrapped block (foreign pointer, double
// free, realloc of a stale pointer). Reported at exit; never affects the
// allocation count.
static volatile long nomen_stale_frees = 0;

#define NOMEN_AUDIT_MAGIC 0x6e6f6d656e415531UL // "nomenAU1"
#define NOMEN_AUDIT_LIVE 1UL
#define NOMEN_AUDIT_DEAD 2UL

typedef struct {
	unsigned long magic;
	unsigned long size;
	unsigned long state;
	unsigned long pad; // keeps the payload 16-byte aligned
} nomen_audit_header;

static void *audit_alloc(unsigned long size) {
	nomen_audit_header *header = (nomen_audit_header *)malloc(size + sizeof(nomen_audit_header));
	if (!header) return 0;
	header->magic = NOMEN_AUDIT_MAGIC;
	header->size = size;
	header->state = NOMEN_AUDIT_LIVE;
	__atomic_add_fetch(&nomen_malloc_count, 1, __ATOMIC_SEQ_CST);
	return (void *)(header + 1);
}

// The header in front of `ptr`, or 0 when `ptr` is not one of ours (a libc
// allocation, a static/BSS address, or already-freed memory whose header was
// cleared).
static nomen_audit_header *audit_header(void *ptr) {
	nomen_audit_header *header = (nomen_audit_header *)ptr - 1;
	if (header->magic != NOMEN_AUDIT_MAGIC) return 0;
	return header;
}

// Retire a block: poison the header first so a second free of the same pointer
// is recognized as stale, then hand the memory back and drop the count.
static void audit_release(nomen_audit_header *header) {
	header->magic = 0;
	header->state = NOMEN_AUDIT_DEAD;
	__atomic_sub_fetch(&nomen_malloc_count, 1, __ATOMIC_SEQ_CST);
	free(header);
}

static long audit_record_stale(void) {
	return __atomic_add_fetch(&nomen_stale_frees, 1, __ATOMIC_SEQ_CST);
}

// Diagnose each KIND once: a shape that double-frees per iteration would
// otherwise print thousands of identical lines. The exit-time
// AUDIT-STALE-FREE count carries the total.
static void audit_report_stale(int kind) {
	static volatile int reported[2] = {0, 0};
	static const char *const messages[2] = {
		"audit: free of a pointer that is not a live audit allocation "
		"(a foreign address, or one already freed)",
		"audit: realloc of a pointer that is not a live audit allocation",
	};
	if (kind < 0 || kind > 1) return;
	if (__atomic_exchange_n(&reported[kind], 1, __ATOMIC_SEQ_CST)) return;
	fprintf(stderr, "%s\n", messages[kind]);
}

void *nomen_malloc_wrap(unsigned long size) {
	return audit_alloc(size);
}

void *nomen_calloc_wrap(unsigned long count, unsigned long size) {
	unsigned long total = count * size;
	void *ptr = audit_alloc(total);
	if (ptr) memset(ptr, 0, total);
	return ptr;
}

void *nomen_strdup_wrap(const char *s) {
	unsigned long len = strlen(s) + 1;
	void *ptr = audit_alloc(len);
	if (ptr) memcpy(ptr, s, len);
	return ptr;
}

// realloc: the count is unchanged (one block in, one block out) — the block is
// only RETIRED, which is what fixes `realloc(p, 0)`: C lets it free `p` and
// return NULL, and the old counter left `p` live, reading as a phantom
// allocation. This implementation always returns the fresh block (a valid
// unique pointer, the other conforming option), so callers that treat a NULL
// result as "the buffer is gone" keep working.
//
// A stale or foreign `old_ptr` reallocates to NULL (realloc's failure mode)
// and is counted as a stale free: the pointer is left untouched rather than
// memcpy'd out of memory that isn't ours.
void *nomen_realloc_wrap(void *old_ptr, unsigned long size) {
	if (!old_ptr) return audit_alloc(size);
	nomen_audit_header *header = audit_header(old_ptr);
	if (!header || header->state != NOMEN_AUDIT_LIVE) {
		audit_record_stale();
		audit_report_stale(1);
		return 0;
	}
	unsigned long old_size = header->size;
	void *ptr = audit_alloc(size);
	// An allocation failure keeps the old block live (realloc's contract).
	if (!ptr) return 0;
	memcpy(ptr, old_ptr, old_size < size ? old_size : size);
	audit_release(header);
	return ptr;
}

void nomen_free_wrap(void *ptr) {
	if (!ptr) return;
	nomen_audit_header *header = audit_header(ptr);
	// Not a live wrapped block: a libc allocation, a static/BSS/rodata
	// address, a pointer the allocator already recycled, or a block this
	// runtime already freed (the double-free case — the header is poisoned on
	// release, so a stale pointer can never look live). Freeing it would be an
	// invalid free, and libmalloc aborts INSIDE free() with no context, which
	// is exactly how the allmark aarch64 sanitize run died. Report it instead
	// of passing it on, and leave the count alone: an unmatched free is not
	// evidence that a live block was reclaimed.
	if (!header || header->state != NOMEN_AUDIT_LIVE) {
		audit_record_stale();
		audit_report_stale(0);
		return;
	}
	audit_release(header);
}

void nomen_audit_check(void) {
	long count = __atomic_load_n(&nomen_malloc_count, __ATOMIC_SEQ_CST);
	if (count != 0) {
		printf("LEAK: %ld allocation(s)\n", count);
	}
	long stale = __atomic_load_n(&nomen_stale_frees, __ATOMIC_SEQ_CST);
	if (stale != 0) {
		printf("AUDIT-STALE-FREE: %ld pointer(s) freed that were not live audit allocations\n",
			   stale);
	}
}

// Per-test leak attribution (`nomen test`): the generated harness snapshots
// the counter before every test and diffs it after, so a leaking test is
// named instead of a whole file aggregating into one exit-time count.
long nomen_audit_count(void) {
	return __atomic_load_n(&nomen_malloc_count, __ATOMIC_SEQ_CST);
}

// Frees that matched no live block (foreign pointer / double free). Polled the
// same way as the count so a run can attribute them like leaks.
long nomen_audit_stale_frees(void) {
	return __atomic_load_n(&nomen_stale_frees, __ATOMIC_SEQ_CST);
}