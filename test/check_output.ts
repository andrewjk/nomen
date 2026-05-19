import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { expect } from "vite-plus/test";

import type BuildResult from "../src/types/BuildResult";

function postprocess_macos(code: string, audit = false): string {
	// macOS prefixes C library symbols with _
	code = code.replace(/\bbl printf\b/g, "bl _printf");
	code = code.replace(/\bbl snprintf\b/g, "bl _snprintf");
	code = code.replace(/\bbl malloc\b/g, "bl _malloc");
	code = code.replace(/\bbl exit\b/g, "bl _exit");
	code = code.replace(/\bbl realloc\b/g, "bl _realloc");
	code = code.replace(/\bbl free\b/g, "bl _free");
	if (audit) {
		code = code.replace(/\bbl _malloc\b/g, "bl _echo_malloc_wrap");
		code = code.replace(/\bbl _free\b/g, "bl _echo_free_wrap");
	}
	// macOS entry point must be _main
	code = code.replace(/\bmain:\n/g, ".globl _main\n_main:\n");
	return code;
}

export default async function check_output(
	name: string,
	built: BuildResult,
	expected_output: string,
	options: { audit?: boolean } = {},
) {
	const folder = path.join(".", "test", "out", name);
	if (!fs.existsSync(folder)) {
		fs.mkdirSync(folder, { recursive: true });
	}

	const codefile = path.join(folder, "main.s");
	const outfile = path.join(folder, "main.out");
	const outputfile = path.join(folder, "output.txt");

	let code = built.code;
	code = postprocess_macos(code, options.audit);

	let stdout: string;
	let stderr: string;

	const audit_runtime = path.join(".", "test", "audit_runtime.c");
	const audit_obj = path.join(folder, "audit_runtime.o");
	const execPromise = util.promisify(exec);
	const compileCmd = options.audit
		? `clang -c ${audit_runtime} -o ${audit_obj} && clang ${codefile} ${audit_obj} -o ${outfile}`
		: `clang -x assembler ${codefile} -o ${outfile}`;

	if (fs.existsSync(codefile)) {
		const previous_code = fs.readFileSync(codefile, "utf-8");
		if (previous_code === code) {
			if (fs.existsSync(outputfile)) {
				stdout = fs.readFileSync(outputfile, "utf-8");
				stderr = "";
			} else {
				const result = await execPromise(`${compileCmd} && ${outfile}`);
				stdout = result.stdout;
				stderr = result.stderr;
				fs.writeFileSync(outputfile, stdout);
			}
		} else {
			fs.writeFileSync(codefile, code);
			const result = await execPromise(`${compileCmd} && ${outfile}`);
			stdout = result.stdout;
			stderr = result.stderr;
			fs.writeFileSync(outputfile, stdout);
		}
	} else {
		fs.writeFileSync(codefile, code);
		const result = await execPromise(`${compileCmd} && ${outfile}`);
		stdout = result.stdout;
		stderr = result.stderr;
		fs.writeFileSync(outputfile, stdout);
	}

	if (stderr && stderr.includes("error:")) {
		expect(stderr).toBeFalsy();
	}
	if (options.audit && stdout && stdout.includes("LEAK:")) {
		expect(stdout).not.toContain("LEAK:");
	}
	expect(stdout.substring(0, expected_output.length)).toBe(expected_output);
}
