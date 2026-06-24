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

if (!input_file || !output_file) {
	console.error("Usage: tsx compile_echo.ts <input.echo> <output_binary> [lib_path]");
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

const result = build(parsed.root, { arch: "aarch64" });

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

const out = path.resolve(output_file);
const folder = path.dirname(out);
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(out + ".s", code);

let link_inputs = `${out}.s`;
if (result.companion) {
	// The companion file includes Foundation/Cocoa headers on apple platforms,
	// so it must be compiled as Objective-C (.m) there.
	const comp_ext = process.platform === "darwin" ? ".m" : ".c";
	const companion_file = `${out}_companion${comp_ext}`;
	fs.writeFileSync(companion_file, result.companion);
	link_inputs += ` ${companion_file}`;
}
execSync(`clang ${link_inputs} -o ${out}`);
