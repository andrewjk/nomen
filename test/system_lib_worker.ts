import { ensure_system_lib } from "./system_lib";

/**
 * Standalone worker (run via `npx tsx test/system_lib_worker.ts`) that builds
 * the precompiled system objects. The globalSetup spawns this as a child
 * process because a pre-existing aarch64 codegen divergence (emit_mode
 * "system" can drop heap-local `.space 8` definitions) is triggered by module
 * state that accumulates in the vitest main process — a fresh process builds
 * the system TU correctly.
 *
 * One object per audit mode: a build's two halves must agree on whether the
 * generated code goes through the audit runtime's wrappers or straight to
 * libc (see `system_paths`), so both variants are prebuilt.
 */
async function main(): Promise<void> {
	await ensure_system_lib(true);
	await ensure_system_lib(false);
}

main().catch((e) => {
	console.error(`[system_lib] worker failed: ${(e as Error).message}`);
	process.exit(1);
});
