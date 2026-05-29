import { exec } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { expect } from "vite-plus/test";

import type BuildResult from "../../src/types/BuildResult";

function postprocess_macos(code: string): string {
	code = code.replace(/\bbl printf\b/g, "bl _printf");
	code = code.replace(/\bbl snprintf\b/g, "bl _snprintf");
	code = code.replace(/\bbl malloc\b/g, "bl _malloc");
	code = code.replace(/\bmain:\n/g, ".globl _main\n_main:\n");
	return code;
}

function compute_cache_key(code: string): string {
	const hash = crypto.createHash("sha256").update(code).digest("hex");
	return hash.substring(0, 16);
}

export default async function check_output_aarch64(
	name: string,
	built: BuildResult,
	expected_output: string,
) {
	const folder = path.join(".", "test", "ziglings", "out", "ziglings_aarch64_" + name);
	if (!fs.existsSync(folder)) {
		fs.mkdirSync(folder, { recursive: true });
	}

	const codefile = path.join(folder, "main.s");
	const outfile = path.join(folder, "main.out");
	const outputfile = path.join(folder, "output.txt");
	const cachefile = path.join(folder, ".cache");

	let code = built.code;
	code = postprocess_macos(code);

	const cache_key = compute_cache_key(code);

	let stdout: string;
	let stderr: string;

	const execPromise = util.promisify(exec);
	const compileCmd = `clang -x assembler ${codefile} -o ${outfile}`;

	const cached_key = fs.existsSync(cachefile) ? fs.readFileSync(cachefile, "utf-8") : null;

	if (cache_key === cached_key && fs.existsSync(outputfile)) {
		stdout = fs.readFileSync(outputfile, "utf-8");
		stderr = "";
	} else {
		fs.writeFileSync(codefile, code);
		const result = await execPromise(`${compileCmd} && ${outfile}`);
		stdout = result.stdout;
		stderr = result.stderr;
		fs.writeFileSync(outputfile, stdout);
		fs.writeFileSync(cachefile, cache_key);
	}

	if (stderr && stderr.includes("error:")) {
		expect(stderr).toBeFalsy();
	}
	expect(stdout.substring(0, expected_output.length)).toBe(expected_output);
}
