import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import build from "../src/build.ts";
import join from "../src/join.ts";
import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";

const input_file = process.argv[2];
const output_file = process.argv[3];
const lib_arg = process.argv[4];
const arch = (process.argv[5] as "c" | "aarch64") ?? "aarch64";
// Optional release toggle (default on — benchmarks are release builds).
// "0" builds the unoptimized baseline for before/after comparisons.
const release = process.argv[6] !== "0";

if (!input_file || !output_file) {
	console.error(
		"Usage: tsx compile_nomen.ts <input.nm> <output_binary> [lib_path] [arch=c|aarch64] [release=1|0]",
	);
	process.exit(1);
}

const resolved = path.resolve(input_file);

let lib_path: string | undefined;
if (lib_arg) {
	const arg_dir = path.resolve(lib_arg);
	const arg_config = path.join(arg_dir, "package.jsonc");
	if (fs.existsSync(arg_config)) {
		const raw = fs.readFileSync(arg_config, "utf8");
		const json = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
		const parsed = JSON.parse(json);
		if (parsed.exports) {
			// lib_arg is the library directory itself
			lib_path = arg_dir;
		} else if (parsed.imports?.System) {
			// lib_arg is a source directory that imports System
			lib_path = path.resolve(arg_dir, parsed.imports.System);
		}
	} else {
		lib_path = arg_dir;
	}
} else {
	const dir = path.dirname(resolved);
	const config_path = path.join(dir, "package.jsonc");
	if (fs.existsSync(config_path)) {
		const raw = fs.readFileSync(config_path, "utf8");
		const json = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
		const parsed = JSON.parse(json);
		if (parsed.imports?.System) {
			lib_path = path.resolve(dir, parsed.imports.System);
		}
	}
}

const source = join(resolved, lib_path);
const library = lib_path ? get_library(lib_path) : undefined;
const parsed = parse(source, library);

if (parsed.errors.length) {
	for (const error of parsed.errors) {
		console.error(`Error: ${error.message}`);
	}
	process.exit(1);
}

const result = build(parsed.root, { arch, optimize: release });

const out = path.resolve(output_file);
const folder = path.dirname(out);
fs.mkdirSync(folder, { recursive: true });

// The companion file includes Foundation/Cocoa headers on apple platforms,
// so it must be compiled as Objective-C (.m) there.
const comp_ext = process.platform === "darwin" ? ".m" : ".c";

if (arch === "c") {
	// C backend: emit headers to main.h (so the generated #include "main.h"
	// resolves) and the program to a .c/.m file, then compile + link.
	fs.writeFileSync(path.join(folder, "main.h"), result.headers);
	const codefile = `${out}${comp_ext}`;
	fs.writeFileSync(codefile, result.code);
	let link_inputs = codefile;
	if (result.companion) {
		const companion_file = `${out}_companion${comp_ext}`;
		fs.writeFileSync(companion_file, result.companion);
		link_inputs += ` ${companion_file}`;
	}
	// -O2 matches the optimized builds the other languages use (go build,
	// zig -O ReleaseFast, cargo --release); at -O0 the C backend's per-char
	// accessors and string adapters stay un-inlined call chains.
	execSync(`clang ${release ? "-O2" : ""} ${link_inputs} -o ${out} -lm`);
} else {
	let code = result.code;
	code = code.replace(/\bbl printf\b/g, "bl _printf");
	code = code.replace(/\bbl snprintf\b/g, "bl _snprintf");
	code = code.replace(/\bbl malloc\b/g, "bl _malloc");
	code = code.replace(/\bbl exit\b/g, "bl _exit");
	code = code.replace(/\bbl realloc\b/g, "bl _realloc");
	code = code.replace(/\bbl free\b/g, "bl _free");
	code = code.replace(/\bbl strdup\b/g, "bl _strdup");
	code = code.replace(/\bbl log\b/g, "bl _log");
	code = code.replace(/\bbl atoi\b/g, "bl _atoi");
	code = code.replace(/\bmain:\n/g, ".globl _main\n_main:\n");
	fs.writeFileSync(out + ".s", code);

	let link_inputs = `${out}.s`;
	if (result.companion) {
		const companion_file = `${out}_companion${comp_ext}`;
		fs.writeFileSync(companion_file, result.companion);
		link_inputs += ` ${companion_file}`;
	}
	// The .s is assembled verbatim (its optimizations are the codegen
	// passes enabled via `optimize` above), but the companion C file (if
	// any) is a real compilation — give it the same -O2 the C backend gets.
	execSync(`clang ${release ? "-O2" : ""} ${link_inputs} -o ${out}`);
}
