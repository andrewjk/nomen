import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { parse_raw } from "./parse_with_imports";
import { system_paths } from "./system_lib";

/**
 * The audit runtime (`src/audit_runtime.c`) is the allocation ledger every
 * `--audit` test reads: `nomen_audit_count()` is the malloc/free balance
 * (`LEAK: N`), polled by the generated harness around each test, and
 * `nomen_audit_check` prints the exit-time verdict.
 *
 * It used to be a bare counter, which cannot tell a correct free from an
 * incorrect one. A free of a pointer the runtime never handed out (a pool /
 * BSS / rodata address, a libc allocation, a stale pointer kept across a
 * realloc) and a second free of the same block both decremented the counter
 * like any other free — so the reported balance drifted away from the
 * allocator's real state, and the `free()` of a non-heap address that aborted
 * the allmark aarch64 sanitize runs inside libmalloc left no audit-level
 * diagnosis at all. Every wrapped block now carries a header, so a free that
 * matches no live block is counted separately (`AUDIT-STALE-FREE: N`) and is
 * NOT passed to libc free; `realloc(p, 0)` no longer leaves a phantom
 * allocation behind.
 *
 * These tests drive the runtime directly (compile it with clang and link small
 * C drivers), since the behaviour is C-level. The last two tests cover the
 * build-side contract the runtime depends on: a non-audited build of a half
 * must not call the wrappers at all, because the halves allocate and free each
 * other's blocks.
 */

const execFile_async = util.promisify(execFile);

const RUNTIME = path.resolve(import.meta.dirname, "../src/audit_runtime.c");

let dir: string;

async function run_driver(name: string, body: string): Promise<{ stdout: string; stderr: string }> {
	const src = path.join(dir, `${name}.c`);
	const bin = path.join(dir, name);
	fs.writeFileSync(
		src,
		`#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void *nomen_malloc_wrap(unsigned long);
void *nomen_calloc_wrap(unsigned long, unsigned long);
void *nomen_realloc_wrap(void *, unsigned long);
void nomen_free_wrap(void *);
void *nomen_strdup_wrap(const char *);
void nomen_audit_check(void);
long nomen_audit_count(void);
long nomen_audit_stale_frees(void);

${body}
`,
	);
	await execFile_async("clang", ["-Wno-unused-result", src, RUNTIME, "-o", bin]);
	return execFile_async(bin);
}

describe("audit runtime", () => {
	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-audit-"));
	});
	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("a matched alloc/free pair leaves the balance and the stale count at zero", async () => {
		const { stdout } = await run_driver(
			"balanced",
			`int main(void) {
	void *p = nomen_malloc_wrap(32);
	memset(p, 7, 32);
	if (((char *)p)[3] != 7) return 2;
	nomen_free_wrap(p);
	printf("count=%ld stale=%ld\\n", nomen_audit_count(), nomen_audit_stale_frees());
	nomen_audit_check();
	return 0;
}
`,
		);
		expect(stdout).toContain("count=0 stale=0");
		expect(stdout).not.toContain("LEAK:");
		expect(stdout).not.toContain("AUDIT-STALE-FREE:");
	});

	test("an unreclaimed block still reports LEAK with the same count", async () => {
		const { stdout } = await run_driver(
			"leaky",
			`int main(void) {
	void *a = nomen_malloc_wrap(16);
	void *b = nomen_calloc_wrap(4, 8);
	void *c = nomen_strdup_wrap("hello");
	if (((char *)c)[0] != 'h') return 2;
	nomen_free_wrap(a);
	nomen_free_wrap(b);
	/* c leaks */
	printf("count=%ld\\n", nomen_audit_count());
	nomen_audit_check();
	return 0;
}
`,
		);
		expect(stdout).toContain("count=1");
		expect(stdout).toContain("LEAK: 1 allocation(s)");
	});

	test("realloc keeps the count and preserves the contents", async () => {
		const { stdout } = await run_driver(
			"realloc_live",
			`int main(void) {
	char *p = (char *)nomen_malloc_wrap(4);
	memcpy(p, "abcd", 4);
	p = (char *)nomen_realloc_wrap(p, 64);
	int ok = memcmp(p, "abcd", 4) == 0 && p[63] == 0;
	printf("count=%ld preserved=%d\\n", nomen_audit_count(), ok);
	nomen_audit_check();
	nomen_free_wrap(p);
	printf("final=%ld stale=%ld\\n", nomen_audit_count(), nomen_audit_stale_frees());
	return ok ? 0 : 3;
}
`,
		);
		expect(stdout).toContain("count=1 preserved=1");
		expect(stdout).toContain("LEAK: 1 allocation(s)");
		// ...and the reallocated block is reclaimable: still one block, not two.
		expect(stdout).toContain("final=0 stale=0");
	});

	test("realloc(NULL, n) is an allocation; realloc(p, 0) is not a phantom one", async () => {
		// realloc(p, 0) frees `p` and may return NULL; the old counter left
		// the block live, so every such call read as one phantom allocation.
		const { stdout } = await run_driver(
			"realloc_zero",
			`int main(void) {
	void *p = nomen_realloc_wrap(0, 32);
	if (!p) return 2;
	printf("alloc=%ld\\n", nomen_audit_count());
	void *q = nomen_realloc_wrap(p, 0);
	printf("after_zero=%ld\\n", nomen_audit_count());
	nomen_free_wrap(q);
	printf("final=%ld stale=%ld\\n", nomen_audit_count(), nomen_audit_stale_frees());
	nomen_audit_check();
	return 0;
}
`,
		);
		expect(stdout).toContain("alloc=1");
		expect(stdout).toContain("after_zero=1");
		expect(stdout).toContain("final=0 stale=0");
		expect(stdout).not.toContain("LEAK:");
	});

	test("a double free is counted as stale, does not free again, and does not abort", async () => {
		const { stdout, stderr } = await run_driver(
			"double_free",
			`int main(void) {
	void *p = nomen_malloc_wrap(32);
	nomen_free_wrap(p);
	nomen_free_wrap(p);
	nomen_free_wrap(p);
	printf("count=%ld stale=%ld\\n", nomen_audit_count(), nomen_audit_stale_frees());
	nomen_audit_check();
	return 0;
}
`,
		);
		expect(stdout).toContain("count=0 stale=2");
		expect(stdout).toContain("AUDIT-STALE-FREE: 2 pointer(s)");
		expect(stdout).not.toContain("LEAK:");
		expect(stderr).toContain("not a live audit allocation");
	});

	test("freeing a non-heap address is reported instead of aborting in free()", async () => {
		// The allmark aarch64 sanitize failure mode: a pointer inside the
		// binary's own BSS reached free(), and libmalloc aborted with
		// "main_address failed" before anything could say why.
		const { stdout, stderr } = await run_driver(
			"foreign_free",
			`static char pool[256];
int main(void) {
	nomen_free_wrap(pool);
	nomen_free_wrap((void *)&pool);
	printf("count=%ld stale=%ld\\n", nomen_audit_count(), nomen_audit_stale_frees());
	nomen_audit_check();
	return 0;
}
`,
		);
		expect(stdout).toContain("count=0 stale=2");
		expect(stdout).toContain("AUDIT-STALE-FREE: 2 pointer(s)");
		expect(stdout).not.toContain("LEAK:");
		expect(stderr).toContain("not a live audit allocation");
	});

	test("freeing a libc allocation through the wrapper is stale, not a silent decrement", async () => {
		const { stdout } = await run_driver(
			"libc_free",
			`int main(void) {
	void *p = malloc(32);
	nomen_free_wrap(p);
	printf("count=%ld stale=%ld\\n", nomen_audit_count(), nomen_audit_stale_frees());
	free(p);
	nomen_audit_check();
	return 0;
}
`,
		);
		expect(stdout).toContain("count=0 stale=1");
		expect(stdout).toContain("AUDIT-STALE-FREE: 1 pointer(s)");
		expect(stdout).not.toContain("LEAK:");
	});

	test("a stale realloc leaves the pointer alone and reports", async () => {
		const { stdout } = await run_driver(
			"stale_realloc",
			`int main(void) {
	void *p = nomen_malloc_wrap(32);
	nomen_free_wrap(p);
	void *q = nomen_realloc_wrap(p, 64);
	printf("realloc=%d count=%ld stale=%ld\\n", q == 0, nomen_audit_count(),
		   nomen_audit_stale_frees());
	nomen_audit_check();
	return 0;
}
`,
		);
		expect(stdout).toContain("realloc=1 count=0 stale=1");
		expect(stdout).toContain("AUDIT-STALE-FREE: 1 pointer(s)");
	});
});
describe("audit mode is a whole-build property", () => {
	// The precompiled System object is linked into user TUs built either way,
	// so it exists once per audit mode (system_paths) and a test links the one
	// matching its own flag. A half that called the wrappers while its partner
	// called libc made every cross-half allocation/free pair mismatched: the
	// count drifted, and a raw `free` of a wrapper-allocated block read as an
	// invalid free inside the allocator.
	const PROGRAM = `
import System

struct Pair {
	var string name
	pub func #init = (self, string n) {
		self.name = n
	}
}

pub func main = () {
	var Pair p = Pair("x")
	p.name = p.name + "!"
	Console.write_line(p.name)
}
`;

	test("a non-audited build of either backend calls no wrapper", () => {
		for (const arch of ["aarch64", "c"] as const) {
			const parsed = parse_raw(PROGRAM);
			expect(parsed.errors).toEqual([]);
			const plain = build(parsed.root, { arch, audit: false });
			expect(plain.errors ?? []).toEqual([]);
			expect(plain.code).not.toContain("nomen_malloc_wrap");
			expect(plain.code).not.toContain("nomen_free_wrap");
			expect(plain.code).not.toContain("nomen_realloc_wrap");
			expect(plain.code).not.toContain("nomen_strdup_wrap");

			const audited = build(parsed.root, { arch, audit: true });
			expect(audited.errors ?? []).toEqual([]);
			expect(audited.code + (audited.headers ?? "") + (audited.companion ?? "")).toContain(
				"nomen_free_wrap",
			);
		}
	});

	test("both system-object variants are prebuilt, one per audit mode", () => {
		for (const arch of ["c", "aarch64"] as const) {
			expect(fs.existsSync(system_paths(arch, true).obj)).toBe(true);
			expect(fs.existsSync(system_paths(arch, false).obj)).toBe(true);
			expect(system_paths(arch, true).obj).not.toBe(system_paths(arch, false).obj);
		}
	});
});
