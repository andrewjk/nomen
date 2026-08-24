import type BuildStatus from "../../build_c/BuildStatus.ts";

export function emit_malloc(status: BuildStatus) {
	status.code += status.audit ? "bl _nomen_malloc_wrap\n" : "bl _malloc\n";
}

export function emit_free(status: BuildStatus) {
	status.code += status.audit ? "bl _nomen_free_wrap\n" : "bl _free\n";
}

export function emit_strdup(status: BuildStatus) {
	// A fat string's len rides x1 across the call — strdup only consumes the
	// ptr half in x0, so preserve x1 (callers storing both halves rely on it;
	// callers that don't are unaffected by the balanced push/pop).
	status.code += `str x1, [sp, #-16]!\n`;
	status.code += status.audit ? "bl _nomen_strdup_wrap\n" : "bl _strdup\n";
	status.code += `ldr x1, [sp], #16\n`;
}
