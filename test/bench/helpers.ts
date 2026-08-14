import fs from "node:fs";
import path from "node:path";

import { expect } from "vite-plus/test";

import build, { build_needs_objc, default_platform } from "../../src/build";
import { get_library } from "../../src/lib";
import parse from "../../src/parse";
import check_output from "../check_output";
import {
	SYSTEM_OBJ,
	SYSTEM_OBJ_A64,
	load_system_fn_names,
	load_system_struct_names,
} from "../system_lib";
const lib = get_library(path.resolve(import.meta.dirname, "../../core"));

export function read_bench(name: string): string {
	return fs.readFileSync(
		path.resolve(import.meta.dirname, `../../bench/nomen/${name}.nm`),
		"utf-8",
	);
}

export function parse_bench(name: string) {
	return parse(read_bench(name), lib);
}

/**
 * Benchmarks link the precompiled system object on both backends (C + aarch64).
 */
async function bench_options(
	parsed: { root: import("../../src/nodes/RootNode").default },
	arch: "aarch64" | "c",
) {
	const options = { arch, audit: true };
	const split =
		!build_needs_objc(parsed.root, default_platform()) &&
		(arch === "aarch64" ? fs.existsSync(SYSTEM_OBJ_A64) : fs.existsSync(SYSTEM_OBJ));
	const result = split
		? build(parsed.root, {
				...options,
				emit_mode: "user",
				system_struct_names: load_system_struct_names(),
			})
		: build(parsed.root, options);
	return {
		result,
		check_opts: { ...options, system_lib: split, system_fn_names: load_system_fn_names() },
	};
}

export async function build_and_check_bench(name: string, expected: string) {
	const source = read_bench(name);
	const parsed = parse(source, lib);
	expect(parsed.errors).toEqual([]);
	for (const arch of ["aarch64", "c"] as const) {
		const { result, check_opts } = await bench_options(parsed, arch);
		await check_output(`${name}_${arch}`, result, expected, check_opts);
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
	const source = read_bench(name);
	const parsed = parse(source, lib);
	expect(parsed.errors).toEqual([]);
	for (const arch of ["aarch64", "c"] as const) {
		const folder = path.resolve(".", "test", "out", arch, `${name}_${arch}`);
		for (const [src, target] of Object.entries(files)) {
			const dest = path.join(folder, target);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.copyFileSync(path.resolve(import.meta.dirname, `../../bench/${src}`), dest);
		}
		const { result, check_opts } = await bench_options(parsed, arch);
		await check_output(`${name}_${arch}`, result, expected, check_opts);
	}
}
