import { exec } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { expect } from "vite-plus/test";

import type BuildResult from "../src/types/BuildResult";

function postprocess_macos(code: string, audit = false): string {
	code = code.replace(/\bbl printf\b/g, "bl _printf");
	code = code.replace(/\bbl snprintf\b/g, "bl _snprintf");
	code = code.replace(/\bbl malloc\b/g, "bl _malloc");
	code = code.replace(/\bbl exit\b/g, "bl _exit");
	code = code.replace(/\bbl realloc\b/g, "bl _realloc");
	code = code.replace(/\bbl free\b/g, "bl _free");
	code = code.replace(/\bbl strdup\b/g, "bl _strdup");
	if (audit) {
		code = code.replace(/\bbl _malloc\b/g, "bl _echo_malloc_wrap");
		code = code.replace(/\bbl _calloc\b/g, "bl _echo_calloc_wrap");
		code = code.replace(/\bbl _realloc\b/g, "bl _echo_realloc_wrap");
		code = code.replace(/\bbl _free\b/g, "bl _echo_free_wrap");
		code = code.replace(/\bbl _strdup\b/g, "bl _echo_strdup_wrap");
	}
	code = code.replace(/\bmain:\n/g, ".globl _main\n_main:\n");
	return code;
}

function compute_cache_key(
	code: string,
	options: { audit?: boolean; provideStdin?: string },
): string {
	const parts = [code];
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

export default async function check_output(
	name: string,
	built: BuildResult,
	expected_output: string,
	options: { audit?: boolean; provideStdin?: string } = { audit: true },
) {
	const folder = path.resolve(".", "test", "out", name);
	if (!fs.existsSync(folder)) {
		fs.mkdirSync(folder, { recursive: true });
	}

	const codefile = path.join(folder, "main.s");
	const outfile = path.join(folder, "main.out");
	const outputfile = path.join(folder, "output.txt");
	const cachefile = path.join(folder, ".cache");
	// The companion file includes Foundation/Cocoa headers on apple platforms,
	// so it must be compiled as Objective-C (.m) there.
	const comp_ext = process.platform === "darwin" ? ".m" : ".c";
	const companionfile = path.join(folder, `main_companion${comp_ext}`);

	let code = built.code;
	code = postprocess_macos(code, options.audit);

	const has_companion = !!built.companion;
	if (has_companion) {
		fs.writeFileSync(companionfile, built.companion!);
	}

	const cache_key = compute_cache_key(code + (built.companion ?? ""), options);

	let stdout: string;
	let stderr: string;

	const audit_runtime = path.join(".", "src", "audit_runtime.c");
	const audit_obj = path.join(folder, "audit_runtime.o");
	const execPromise = util.promisify(exec);
	let link_inputs = codefile;
	if (has_companion) link_inputs += ` ${companionfile}`;
	if (options.audit) link_inputs += ` ${audit_obj}`;
	const compileCmd = options.audit
		? `clang -c ${audit_runtime} -o ${audit_obj} && clang ${link_inputs} -o ${outfile}`
		: `clang ${link_inputs} -o ${outfile}`;

	const cached_key = fs.existsSync(cachefile) ? fs.readFileSync(cachefile, "utf-8") : null;

	if (cache_key === cached_key && fs.existsSync(outputfile)) {
		stdout = fs.readFileSync(outputfile, "utf-8");
		stderr = "";
	} else {
		fs.writeFileSync(codefile, code);
		const compile_result = await execPromise(compileCmd);
		let run_cmd = `"${outfile}"`;
		if (options.provideStdin !== undefined) {
			const inputfile = path.join(folder, "input.txt");
			fs.writeFileSync(inputfile, options.provideStdin);
			run_cmd = `"${outfile}" < "${inputfile}"`;
		}
		const run_result = await execPromise(run_cmd, { cwd: folder });
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
