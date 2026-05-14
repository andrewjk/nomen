import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { expect } from "vite-plus/test";

import type BuildResult from "../src/types/BuildResult";

function postprocess_macos(code: string): string {
	// macOS prefixes C library symbols with _
	code = code.replace(/\bbl printf\b/g, "bl _printf");
	code = code.replace(/\bbl snprintf\b/g, "bl _snprintf");
	code = code.replace(/\bbl malloc\b/g, "bl _malloc");
	code = code.replace(/\bbl exit\b/g, "bl _exit");
	// macOS entry point must be _main
	code = code.replace(/\bmain:\n/g, ".globl _main\n_main:\n");
	return code;
}

export default async function check_output(
	name: string,
	built: BuildResult,
	expected_output: string,
) {
	const folder = path.join(".", "test", "out", name);
	if (!fs.existsSync(folder)) {
		fs.mkdirSync(folder, { recursive: true });
	}

	const codefile = path.join(folder, "main.s");
	const outfile = path.join(folder, "main.out");
	const outputfile = path.join(folder, "output.txt");

	let code = built.code;
	code = postprocess_macos(code);

	let stdout: string;
	let stderr: string;

	const execPromise = util.promisify(exec);

	if (fs.existsSync(codefile)) {
		const previous_code = fs.readFileSync(codefile, "utf-8");
		if (previous_code === code) {
			if (fs.existsSync(outputfile)) {
				stdout = fs.readFileSync(outputfile, "utf-8");
				stderr = "";
			} else {
				const result = await execPromise(
					`clang -x assembler ${codefile} -o ${outfile} && ${outfile}`,
				);
				stdout = result.stdout;
				stderr = result.stderr;
				fs.writeFileSync(outputfile, stdout);
			}
		} else {
			fs.writeFileSync(codefile, code);
			const result = await execPromise(
				`clang -x assembler ${codefile} -o ${outfile} && ${outfile}`,
			);
			stdout = result.stdout;
			stderr = result.stderr;
			fs.writeFileSync(outputfile, stdout);
		}
	} else {
		fs.writeFileSync(codefile, code);
		const result = await execPromise(`clang -x assembler ${codefile} -o ${outfile} && ${outfile}`);
		stdout = result.stdout;
		stderr = result.stderr;
		fs.writeFileSync(outputfile, stdout);
	}

	if (stderr && stderr.includes("error:")) {
		expect(stderr).toBeFalsy();
	}
	expect(stdout.substring(0, expected_output.length)).toBe(expected_output);
}
