import type BuildStatus from "../../build_c/BuildStatus.ts";
import { emit_asm } from "./code_buffer.ts";

export function emit_malloc(status: BuildStatus) {
	emit_asm(status, status.audit ? "bl _nomen_malloc_wrap\n" : "bl _malloc\n");
}

export function emit_free(status: BuildStatus) {
	emit_asm(status, status.audit ? "bl _nomen_free_wrap\n" : "bl _free\n");
}

/**
 * Heap-copy the fat string in (x0=ptr, x1=len), leaving the owned copy's
 * pair in (x0, x1). Length-based (malloc + memcpy + NUL terminator), not
 * strdup: strings are byte arrays and may hold NUL bytes, which strdup
 * would truncate at. A NULL ptr stays NULL. Clobbers the caller-saved
 * registers, as a strdup call does — callers must load the len half into
 * x1 first. The `// str_copy` marker on the memcpy lets tests count copies.
 */
export function emit_strdup(status: BuildStatus) {
	const skip = `.Lstrdup_null_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
	emit_asm(status, `cbz x0, ${skip}\n`);
	emit_asm(status, `stp x0, x1, [sp, #-16]!\n`);
	emit_asm(status, `add x0, x1, #1\n`);
	emit_malloc(status);
	emit_asm(status, `ldp x1, x2, [sp]\n`);
	emit_asm(status, `bl _memcpy // str_copy\n`);
	emit_asm(status, `ldr x1, [sp, #8]\n`);
	emit_asm(status, `strb wzr, [x0, x1]\n`);
	emit_asm(status, `add sp, sp, #16\n`);
	emit_asm(status, `${skip}:\n`);
}
