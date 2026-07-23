import type BuildStatus from "../../build_c/BuildStatus.ts";

export function emit_malloc(status: BuildStatus) {
	status.code += status.audit ? "bl _nomen_malloc_wrap\n" : "bl _malloc\n";
}

export function emit_free(status: BuildStatus) {
	status.code += status.audit ? "bl _nomen_free_wrap\n" : "bl _free\n";
}

export function emit_strdup(status: BuildStatus) {
	status.code += status.audit ? "bl _nomen_strdup_wrap\n" : "bl _strdup\n";
}
