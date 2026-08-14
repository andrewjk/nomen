import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { SYSTEM_OBJ, SYSTEM_OBJ_A64 } from "./system_lib";

const execPromise = util.promisify(exec);

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
export default async function setup(): Promise<void> {
	const script = path.resolve(import.meta.dirname, "system_lib_worker.ts");
	try {
		await execPromise(`npx tsx "${script}"`, { maxBuffer: 10 * 1024 * 1024 });
	} catch (e) {
		console.error(
			`[system_lib] prebuild worker failed:\n${(e as Error).message?.split("\n").slice(0, 6).join("\n")}`,
		);
	}
	console.log(
		`[system_lib] C object: ${fs.existsSync(SYSTEM_OBJ) ? "built" : "missing"}; ` +
			`aarch64 object: ${fs.existsSync(SYSTEM_OBJ_A64) ? "built" : "missing (single-TU fallback)"}`,
	);
}
