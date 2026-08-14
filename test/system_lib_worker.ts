import { ensure_system_lib } from "./system_lib";

/**
 * Standalone worker (run via `npx tsx test/system_lib_worker.ts`) that builds
 * the precompiled system objects. The globalSetup spawns this as a child
 * process because a pre-existing aarch64 codegen divergence (emit_mode
 * "system" can drop heap-local `.space 8` definitions) is triggered by module
 * state that accumulates in the vitest main process — a fresh process builds
 * the system TU correctly.
 */
async function main(): Promise<void> {
	await ensure_system_lib();
}

main().catch((e) => {
	console.error(`[system_lib] worker failed: ${(e as Error).message}`);
	process.exit(1);
});
