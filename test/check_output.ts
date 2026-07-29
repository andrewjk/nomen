import { exec } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { expect } from "vite-plus/test";

import type BuildResult from "../src/types/BuildResult";

const execPromise = util.promisify(exec);

// Apple ObjC runtime symbols only ever appear in raw `#arch: c`/`aarch64_use_c`
// blocks (the codegen never synthesises them). Their presence is the same signal
// build_c/build_root_node uses to gate Foundation/Cocoa imports, so reuse it to
// decide whether to link the (expensive) Apple frameworks at all.
const OBJC_RE = /\bobjc_msgSend\b|\bobjc_getClass\b|\bsel_registerName\b/;

// audit_runtime.c is byte-for-byte identical for every test, so compile it once
// into a shared object keyed by its content hash and reuse it across the whole
// suite (the per-test recompile was ~0.06s × 200+ cold-cache misses).
// Parallel-safe: each contender writes a uniquely-suffixed temp file then
// renames it into place atomically; the bytes are deterministic, so a lost race
// just overwrites identical content.
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
	options: { arch?: "c" | "aarch64"; audit?: boolean; provideStdin?: string } = { audit: true },
) {
	const arch = options.arch ?? "c";
	const folder = path.resolve(".", "test", "out", arch, name);
	if (!fs.existsSync(folder)) {
		fs.mkdirSync(folder, { recursive: true });
	}

	const codefile_ext = arch === "aarch64" ? ".s" : process.platform === "darwin" ? ".m" : ".c";
	const codefile = path.join(folder, `main${codefile_ext}`);
	const outfile = path.join(folder, "main.out");
	const outputfile = path.join(folder, "output.txt");
	const cachefile = path.join(folder, ".cache");
	// The companion file includes Foundation/Cocoa headers on apple platforms,
	// so it must be compiled as Objective-C (.m) there.
	const comp_ext = process.platform === "darwin" ? ".m" : ".c";
	const companionfile = path.join(folder, `main_companion${comp_ext}`);

	let code = built.code;
	code = postprocess_macos(code, options.audit, arch);

	const has_companion = !!built.companion;
	if (has_companion) {
		fs.writeFileSync(companionfile, built.companion!);
	}

	const headerfile = path.join(folder, "main.h");
	if (built.headers) {
		fs.writeFileSync(headerfile, built.headers);
	}

	const cache_key = compute_cache_key(code + (built.companion ?? ""), options);

	let stdout: string;
	let stderr: string;

	const audit_obj = options.audit ? await ensure_audit_obj() : null;
	// Only link Apple frameworks when the generated code actually uses the ObjC
	// runtime (GUI builds). The previous unconditional flags added ~0.23s of
	// pure link overhead to every macOS test — a 5-10x tax that ~99% of tests
	// never need.
	const uses_objc =
		OBJC_RE.test(code) ||
		OBJC_RE.test(built.headers || "") ||
		(!!built.companion && OBJC_RE.test(built.companion));
	const framework_flags =
		process.platform === "darwin" && uses_objc
			? " -framework CoreGraphics -framework Foundation -framework AppKit -lobjc"
			: "";
	let compileCmd: string;
	if (arch === "aarch64") {
		const main_obj = path.join(folder, "main.o");
		const comp_obj = path.join(folder, "main_companion.o");
		let steps: string[] = [];
		steps.push(`clang -c -x assembler ${codefile} -o ${main_obj}`);
		let link_inputs = main_obj;
		if (has_companion) {
			steps.push(`clang -c ${companionfile} -o ${comp_obj}`);
			link_inputs += ` ${comp_obj}`;
		}
		if (options.audit && audit_obj) {
			link_inputs += ` ${audit_obj}`;
		}
		steps.push(`clang ${link_inputs} -o ${outfile}${framework_flags}`);
		compileCmd = steps.join(" && ");
	} else {
		let link_inputs = codefile;
		if (has_companion) link_inputs += ` ${companionfile}`;
		if (options.audit && audit_obj) link_inputs += ` ${audit_obj}`;
		compileCmd = `clang -o ${outfile} ${link_inputs}${framework_flags}`;
	}

	const cached_key = fs.existsSync(cachefile) ? fs.readFileSync(cachefile, "utf-8") : null;

	if (cache_key === cached_key && fs.existsSync(outputfile)) {
		stdout = fs.readFileSync(outputfile, "utf-8");
		stderr = "";
	} else {
		fs.writeFileSync(codefile, code);
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
	if (options.audit && stdout && stdout.includes("LEAK:")) {
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

function postprocess_macos(code: string, audit = false, arch: string = "c"): string {
	if (arch === "aarch64") {
		code = code.replace(/\bbl printf\b/g, "bl _printf");
		code = code.replace(/\bbl snprintf\b/g, "bl _snprintf");
		code = code.replace(/\bbl malloc\b/g, "bl _malloc");
		code = code.replace(/\bbl exit\b/g, "bl _exit");
		code = code.replace(/\bbl realloc\b/g, "bl _realloc");
		code = code.replace(/\bbl free\b/g, "bl _free");
		code = code.replace(/\bbl strdup\b/g, "bl _strdup");
		if (audit) {
			code = code.replace(/\bbl _malloc\b/g, "bl _nomen_malloc_wrap");
			code = code.replace(/\bbl _calloc\b/g, "bl _nomen_calloc_wrap");
			code = code.replace(/\bbl _realloc\b/g, "bl _nomen_realloc_wrap");
			code = code.replace(/\bbl _free\b/g, "bl _nomen_free_wrap");
			code = code.replace(/\bbl _strdup\b/g, "bl _nomen_strdup_wrap");
		}
		code = code.replace(/\bmain:\n/g, ".globl _main\n_main:\n");
	}
	return code;
}
