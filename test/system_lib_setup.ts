import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { system_paths } from "./system_lib";

const execPromise = util.promisify(exec);

/**
 * Resolve a runnable `tsx`: the CLI workspace vendors it (`cli/node_modules`),
 * the root may not — and `npx tsx` fails outright when the package isn't
 * root-installed and the registry is unreachable. Falls back to `npx tsx`
 * for layouts where only the root install exists.
 */
function resolve_tsx(): string {
	const local_bin = path.resolve(import.meta.dirname, "../cli/node_modules/.bin/tsx");
	if (fs.existsSync(local_bin)) return `"${local_bin}"`;
	const root_bin = path.resolve(import.meta.dirname, "../node_modules/.bin/tsx");
	if (fs.existsSync(root_bin)) return `"${root_bin}"`;
	return "npx tsx";
}

/**
 * vitest globalSetup: builds the precompiled system objects ONCE before any
 * test runs (rebuilding only when the System library source or the generated
 * system TU changes), then every test links them instead of recompiling the
 * System library per test — which removed the cold-run timeouts.
 *
 * The build runs in a child `tsx` process (fresh module state): a pre-existing
 * aarch64 codegen divergence can otherwise be triggered by state in the vitest
 * main process. C-backend tests always link their object; aarch64 falls back
 * to single-TU if its object couldn't be built.
 */
/** Age (ms) after which a leaked scratch dir is pruned (another concurrent
 *  vitest run may legitimately own a younger one). */
const STALE_SCRATCH_MS = 60 * 60 * 1000;
/** Age after which stale build-cache files are pruned. */
const STALE_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Keep `test/out` bounded. Two classes of leftovers accumulate:
 * - `run-*` scratch dirs: a killed/crashed run can leave one behind. They are
 *   deleted here when older than an hour (a concurrent suite may own a fresh
 *   one).
 * - build-cache entries (`*.build.json`, `*.ok`): every compiler edit changes
 *   the cache key, so old-key files linger. Entries older than a week go.
 */
function prune_test_out(): void {
	const root = path.resolve("test", "out");
	if (!fs.existsSync(root)) return;
	const now = Date.now();
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.startsWith("run-")) {
					try {
						if (now - fs.statSync(full).mtimeMs > STALE_SCRATCH_MS) {
							fs.rmSync(full, { recursive: true, force: true });
						}
					} catch {}
					continue;
				}
				walk(full);
				continue;
			}
			if (entry.name.endsWith(".build.json") || entry.name.endsWith(".ok")) {
				try {
					if (now - fs.statSync(full).mtimeMs > STALE_CACHE_MS) {
						fs.rmSync(full, { force: true });
					}
				} catch {}
			}
		}
	};
	walk(root);
}

export default async function setup(): Promise<void> {
	prune_test_out();
	const script = path.resolve(import.meta.dirname, "system_lib_worker.ts");
	// The prebuild is the barrier workers start behind, so a FAILURE here must
	// stop the run: proceeding would leave stale/unbuilt objects that the
	// freshness test's mid-suite self-heal then rebuilds while other workers
	// are linking — the rebuild/worker race behind the 1–27 spurious
	// link/audit failures on the first run after a core edit. (Expected
	// fallbacks — the aarch64 codegen divergence that can make the system asm
	// unassembleable — are handled inside ensure_system_lib, which removes the
	// object and exits 0; only unexpected errors get here.)
	try {
		await execPromise(`${resolve_tsx()} "${script}"`, { maxBuffer: 10 * 1024 * 1024 });
	} catch (e) {
		throw new Error(
			`[system_lib] prebuild worker failed — fix the state in test/out/system_lib (or delete it; the next run rebuilds) and re-run:\n${(e as Error).message?.split("\n").slice(0, 8).join("\n")}`,
		);
	}
	// Both audit variants are prebuilt; a test links the one matching its own
	// audit flag (mixing the halves makes the audit counter meaningless).
	const c = system_paths("c", true);
	const a64 = system_paths("aarch64", true);
	const c_plain = system_paths("c", false);
	const a64_plain = system_paths("aarch64", false);
	console.log(
		`[system_lib] C object: ${fs.existsSync(c.obj) ? "built" : "missing"}` +
			`${fs.existsSync(c_plain.obj) ? "" : " (plain missing)"}; ` +
			`aarch64 object: ${fs.existsSync(a64.obj) ? "built" : "missing (single-TU fallback)"}` +
			`${fs.existsSync(a64_plain.obj) ? "" : " (plain missing)"}`,
	);
}
