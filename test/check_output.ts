import { exec } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { expect } from "vite-plus/test";

import type BuildResult from "../src/types/BuildResult";
import { postprocess_macos, postprocess_macos_for_user } from "./postprocess";
import { SYSTEM_H, SYSTEM_HASH, SYSTEM_HASH_A64, SYSTEM_OBJ, SYSTEM_OBJ_A64 } from "./system_lib";

const execPromise = util.promisify(exec);

// Apple ObjC runtime symbols only ever appear in raw `#arch: c`/`aarch64_use_c`
// blocks (the codegen never synthesises them). Their presence is the same signal
// build_c/build_root_node uses to gate Foundation/Cocoa imports, so reuse it to
// decide whether to link the (expensive) Apple frameworks at all.
const OBJC_RE = /\bobjc_msgSend\b|\bobjc_getClass\b|\bsel_registerName\b/;

// audit_runtime.c is byte-for-byte identical for every test, so compile it once
// into a shared object keyed by its content hash and reuse it across the whole
// suite. Parallel-safe (atomic temp-then-rename).
let cached_audit_hash: string | null = null;

async function ensure_audit_obj(): Promise<string | null> {
	const audit_runtime = path.join(".", "src", "audit_runtime.c");
	if (!fs.existsSync(audit_runtime)) return null;
	const source = fs.readFileSync(audit_runtime, "utf8");
	let hash = cached_audit_hash;
	if (hash === null) {
		const h = crypto.createHash("sha256");
		h.update(source);
		hash = h.digest("hex").substring(0, 16);
		cached_audit_hash = hash;
	}
	const out_dir = path.resolve(".", "test", "out");
	if (!fs.existsSync(out_dir)) fs.mkdirSync(out_dir, { recursive: true });
	const audit_obj = path.join(out_dir, `audit_runtime_${hash}.o`);
	if (!fs.existsSync(audit_obj)) {
		const tmp = `${audit_obj}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
		await execPromise(`clang -c ${audit_runtime} -o ${tmp}`);
		fs.renameSync(tmp, audit_obj);
	}
	return audit_obj;
}

export default async function check_output(
	name: string,
	built: BuildResult,
	expected_output: string,
	options: {
		arch?: "c" | "aarch64";
		audit?: boolean;
		provideStdin?: string;
		/** Link the precompiled system object (C-backend split). The caller
		 *  builds a user-only TU (emit_mode "user"); System code comes from the
		 *  one object built once in the globalSetup. */
		system_lib?: boolean;
		/** Function names exported by the aarch64 system object — the user TU's
		 *  references to them are rewritten to the Mach-O `_name` aliases. */
		system_fn_names?: string[];
	} = { audit: true },
) {
	const arch = options.arch ?? "c";
	const audit = options.audit ?? true;
	const system_lib = !!options.system_lib;
	const folder = path.resolve(".", "test", "out", arch, name);
	if (!fs.existsSync(folder)) {
		fs.mkdirSync(folder, { recursive: true });
	}

	const codefile_ext = arch === "aarch64" ? ".s" : process.platform === "darwin" ? ".m" : ".c";
	const codefile = path.join(folder, `main${codefile_ext}`);
	const outfile = path.join(folder, "main.out");
	const outputfile = path.join(folder, "output.txt");
	const cachefile = path.join(folder, ".cache");
	const comp_ext = process.platform === "darwin" ? ".m" : ".c";
	const companionfile = path.join(folder, `main_companion${comp_ext}`);

	let code: string;
	if (arch === "aarch64" && system_lib) {
		// Rewrite the user TU's references to System functions to the exported
		// `_name` aliases (Mach-O), plus libc/main/audit handling.
		code = postprocess_macos_for_user(built.code, audit, options.system_fn_names ?? []);
	} else {
		code = postprocess_macos(built.code, audit, arch);
	}

	const has_companion = !!built.companion;
	if (has_companion) {
		fs.writeFileSync(companionfile, built.companion!);
	}

	const headerfile = path.join(folder, "main.h");
	if (built.headers) {
		fs.writeFileSync(headerfile, built.headers);
	}

	// When linking the precompiled system object, the user TU's main.h does
	// `#include "system.h"` (C only) — stage the prebuilt system header + fold
	// the system object's hash into the output cache key so a system.o rebuild
	// invalidates cached stdout.
	let system_hash = "";
	if (system_lib) {
		const hash_file = arch === "aarch64" ? SYSTEM_HASH_A64 : SYSTEM_HASH;
		if (arch === "c") fs.copyFileSync(SYSTEM_H, path.join(folder, "system.h"));
		system_hash = fs.existsSync(hash_file) ? fs.readFileSync(hash_file, "utf8") : "";
	}

	const cache_key = compute_cache_key(code + system_hash + (built.companion ?? ""), {
		...options,
		arch,
	});

	let stdout: string;
	let stderr: string;

	// The system object references the audit wrappers (nomen_malloc_wrap), so
	// whenever we link it we must also link audit_runtime.o — regardless of the
	// individual test's audit flag.
	const audit_obj = system_lib || audit ? await ensure_audit_obj() : null;
	const uses_objc =
		OBJC_RE.test(code) ||
		OBJC_RE.test(built.headers || "") ||
		(!!built.companion && OBJC_RE.test(built.companion));
	const framework_flags =
		process.platform === "darwin" && uses_objc
			? " -framework CoreGraphics -framework Foundation -framework AppKit -lobjc"
			: "";
	const system_obj = system_lib ? (arch === "aarch64" ? SYSTEM_OBJ_A64 : SYSTEM_OBJ) : null;

	const cached_key = fs.existsSync(cachefile) ? fs.readFileSync(cachefile, "utf-8") : null;

	if (cache_key === cached_key && fs.existsSync(outputfile)) {
		stdout = fs.readFileSync(outputfile, "utf-8");
		stderr = "";
	} else {
		fs.writeFileSync(codefile, code);
		let compileCmd: string;
		if (arch === "aarch64") {
			const main_obj = path.join(folder, "main.o");
			const comp_obj = path.join(folder, "main_companion.o");
			const steps: string[] = [];
			steps.push(`clang -c -x assembler ${codefile} -o ${main_obj}`);
			let link_inputs = main_obj;
			if (has_companion) {
				steps.push(`clang -c ${companionfile} -o ${comp_obj}`);
				link_inputs += ` ${comp_obj}`;
			}
			if (system_obj) link_inputs += ` ${system_obj}`;
			if (audit_obj) link_inputs += ` ${audit_obj}`;
			steps.push(`clang ${link_inputs} -o ${outfile}${framework_flags}`);
			compileCmd = steps.join(" && ");
		} else {
			let link_inputs = codefile;
			if (has_companion) link_inputs += ` ${companionfile}`;
			if (system_obj) link_inputs += ` ${system_obj}`;
			if (audit_obj) link_inputs += ` ${audit_obj}`;
			compileCmd = `clang -o ${outfile} ${link_inputs}${framework_flags}`;
		}
		const compile_result = await execPromise(compileCmd, { maxBuffer: 10 * 1024 * 1024 });
		let run_cmd = `"${outfile}"`;
		if (options.provideStdin !== undefined) {
			const inputfile = path.join(folder, "input.txt");
			fs.writeFileSync(inputfile, options.provideStdin);
			run_cmd = `"${outfile}" < "${inputfile}"`;
		}
		const run_result = await execPromise(run_cmd, { cwd: folder, maxBuffer: 10 * 1024 * 1024 });
		stdout = run_result.stdout;
		stderr = (compile_result.stderr || "") + (run_result.stderr || "");
		fs.writeFileSync(outputfile, stdout);
		fs.writeFileSync(cachefile, cache_key);
	}

	if (stderr && stderr.includes("error:")) {
		expect(stderr).toBeFalsy();
	}
	if (audit && stdout && stdout.includes("LEAK:")) {
		expect(stdout).not.toContain("LEAK:");
	}
	expect(stdout.substring(0, expected_output.length)).toBe(expected_output);
}

function compute_cache_key(
	code: string,
	options: { arch?: string; audit?: boolean; provideStdin?: string },
): string {
	const parts = [code];
	if (options.arch) {
		parts.push(`arch:${options.arch}`);
	}
	if (options.audit) {
		const audit_runtime = path.join(".", "src", "audit_runtime.c");
		if (fs.existsSync(audit_runtime)) {
			parts.push(fs.readFileSync(audit_runtime, "utf-8"));
		}
	}
	if (options.provideStdin !== undefined) {
		parts.push(`stdin:${options.provideStdin}`);
	}
	const hash = crypto.createHash("sha256");
	for (const part of parts) {
		hash.update(part);
	}
	return hash.digest("hex").substring(0, 16);
}
