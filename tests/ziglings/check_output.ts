import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { expect } from "vite-plus/test";

import type BuildResult from "../../src/types/BuildResult";

export default async function check_output(
	name: string,
	built: BuildResult,
	expected_output: string,
) {
	const folder = path.join(".", "tests", "ziglings", "out", "ziglings_" + name);
	if (!fs.existsSync(folder)) {
		fs.mkdirSync(folder);
	}

	const headerfile = path.join(folder, "main.h");
	const codefile = path.join(folder, "main.c");
	const outfile = path.join(folder, "main.out");
	const outputfile = path.join(folder, "output.txt");

	fs.writeFileSync(headerfile, built.headers);

	const execPromise = util.promisify(exec);

	let stdout: string;
	let stderr: string;

	if (fs.existsSync(codefile)) {
		const previous_code = fs.readFileSync(codefile, "utf-8");
		if (previous_code === built.code) {
			if (fs.existsSync(outputfile)) {
				stdout = fs.readFileSync(outputfile, "utf-8");
				stderr = "";
			} else {
				const result = await execPromise(`clang ${codefile} -o ${outfile} && ${outfile}`);
				stdout = result.stdout;
				stderr = result.stderr;
				fs.writeFileSync(outputfile, stdout);
			}
		} else {
			fs.writeFileSync(codefile, built.code);
			const result = await execPromise(`clang ${codefile} -o ${outfile} && ${outfile}`);
			stdout = result.stdout;
			stderr = result.stderr;
			fs.writeFileSync(outputfile, stdout);
		}
	} else {
		fs.writeFileSync(codefile, built.code);
		const result = await execPromise(`clang ${codefile} -o ${outfile} && ${outfile}`);
		stdout = result.stdout;
		stderr = result.stderr;
		fs.writeFileSync(outputfile, stdout);
	}

	expect(stderr).toBeFalsy();
	expect(stdout.substring(0, expected_output.length)).toBe(expected_output);
}
