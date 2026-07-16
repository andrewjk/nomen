import fs from "node:fs";
import path from "node:path";

import { expect } from "vite-plus/test";

import build from "../../src/build";
import { get_library } from "../../src/lib";
import parse from "../../src/parse";
import check_output from "../check_output";
const lib = get_library(path.resolve(import.meta.dirname, "../../core"));

export function read_bench(name: string): string {
	return fs.readFileSync(
		path.resolve(import.meta.dirname, `../../bench/echo/${name}.echo`),
		"utf-8",
	);
}

export function parse_bench(name: string) {
	return parse(read_bench(name), lib);
}

export async function build_and_check_bench(name: string, expected: string) {
	const parsed = parse_bench(name);
	expect(parsed.errors).toEqual([]);
	for (const arch of ["aarch64", "c"] as const) {
		const result = build(parsed.root, { arch, audit: false });
		await check_output(`${name}_${arch}`, result, expected, {
			arch,
			audit: false,
		});
	}
}

// Like build_and_check_bench, but stages one or more input files into the
// executable's working directory first. `files` maps a project-relative source
// path to the relative path the binary expects (relative to its CWD).
export async function build_and_check_bench_with_files(
	name: string,
	expected: string,
	files: Record<string, string>,
) {
	const parsed = parse_bench(name);
	expect(parsed.errors).toEqual([]);
	for (const arch of ["aarch64", "c"] as const) {
		const folder = path.resolve(".", "test", "out", arch, `${name}_${arch}`);
		for (const [src, target] of Object.entries(files)) {
			const dest = path.join(folder, target);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.copyFileSync(path.resolve(import.meta.dirname, `../../bench/${src}`), dest);
		}
		const result = build(parsed.root, { arch, audit: false });
		await check_output(`${name}_${arch}`, result, expected, {
			arch,
			audit: false,
		});
	}
}
