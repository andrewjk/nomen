#! /usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import chokidar from "chokidar";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";

import build from "../../src/build.ts";
import join from "../../src/join.ts";
import parse from "../../src/parse.ts";
import render_errors from "./format_errors.ts";
import type Config from "./types/Config.ts";

const SUPPORTED_EXTENSION = ".echo";

console.log("\n~ ECHO ~\n");

const options = yargs(hideBin(process.argv))
	.usage("Usage: lang --in [file/folder]")
	.option("in", {
		alias: "i",
		describe: "Input file or folder",
		type: "string",
	})
	.option("out", {
		alias: "o",
		describe: "Output file",
		type: "string",
	})
	.option("config", {
		alias: "c",
		describe: "The path to a config file",
		type: "string",
	})
	.option("watch", {
		alias: "w",
		describe: "Whether to watch for file changes",
		type: "boolean",
	})
	.option("arch", {
		alias: "a",
		describe: "Target architecture (aarch64 or c)",
		type: "string",
		default: "aarch64",
	})
	.option("lib", {
		alias: "l",
		describe: "Path to System library directory (containing package.jsonc)",
		type: "string",
	})
	.option("audit", {
		describe: "Whether to audit the generated program for memory issues",
		type: "boolean",
	})
	.option("audit-runtime", {
		describe: "Path to audit_runtime.c, linked in when --audit is set",
		type: "string",
	})
	.help(true)
	.check((argv) => {
		if (!argv._.length && !argv.in) {
			throw new Error("Missing required argument: in");
		}
		return true;
	})
	.parseSync();

try {
	if (!options.in) {
		process.exit(0);
	}

	if (fs.existsSync(options.in)) {
		let config: Config = { arch: "aarch64" };
		// Load the config from a file
		if (options.config && fs.existsSync(options.config)) {
			config = JSON.parse(fs.readFileSync(options.config, "utf-8"));
		}
		// Overwrite with args
		if (options.arch) config.arch = options.arch as "aarch64" | "c";
		if (options.lib) config.lib = options.lib;
		if (options.audit) config.audit = options.audit;
		if (options["audit-runtime"]) config.audit_runtime = options["audit-runtime"];

		// Is the --in path a folder
		if (fs.lstatSync(options.in).isDirectory()) {
			// Loop through files in the folder
			//processFolder(options.in);
			if (options.watch) {
				watchPath(options.in, config);
			} else {
				processFolder(options.in, config);
			}
		} else {
			// Process the supplied file
			const extname = path.extname(options.in);
			if (shouldProcessFile(options.in)) {
				//processFile(options.in);
				// NOTE: We get add notifications for all watched files immediately
				// TODO: Is this the case on Windows etc too?
				if (options.watch) {
					watchPath(options.in, config);
				} else {
					processFile(options.in, config);
				}
			} else {
				console.log("Unsupported file type: " + extname);
			}
		}
	} else {
		console.log("Path not found: " + options.in);
	}
} catch (err) {
	console.log("UH", err);
}

function resolve_lib(file_path: string): string | undefined {
	const dir = path.dirname(path.resolve(file_path));
	const config_path = path.join(dir, "package.jsonc");
	if (!fs.existsSync(config_path)) return undefined;
	const raw = fs.readFileSync(config_path, "utf8");
	const json = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
	const parsed = JSON.parse(json);
	if (parsed.imports?.System) {
		return path.resolve(dir, parsed.imports.System);
	}
	return undefined;
}

function resolve_audit_runtime(config: Config, input_path: string): string | undefined {
	if (config.audit_runtime) {
		const explicit = path.resolve(config.audit_runtime);
		return fs.existsSync(explicit) ? explicit : undefined;
	}
	let dir = path.dirname(input_path);
	for (let i = 0; i < 20; i++) {
		const candidate = path.join(dir, "src", "audit_runtime.c");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

function compile_audit_runtime(config: Config, input_path: string, buildDir: string): string {
	const runtime_src = resolve_audit_runtime(config, input_path);
	if (!runtime_src) {
		throw new Error(
			"Audit enabled but audit_runtime.c was not found. Pass --audit-runtime <path/to/audit_runtime.c>.",
		);
	}
	const audit_obj = path.join(buildDir, "audit_runtime.o");
	execSync(`clang -c ${runtime_src} -o ${audit_obj}`);
	return audit_obj;
}

function watchPath(p: string, config: Config) {
	chokidar.watch(p).on("all", (event, filePath) => {
		if (shouldProcessFile(filePath)) {
			processFile(filePath, config);
		}
	});
}

function processFolder(folder: string, config: Config) {
	const dir = fs.opendirSync(folder);
	let dirent;
	while ((dirent = dir.readSync()) !== null) {
		if (shouldProcessFile(dirent.name)) {
			processFile(path.join(folder, dirent.name), config);
			// @ts-ignore
			let _ = fs.watch;
		}
	}
	dir.closeSync();
}

function shouldProcessFile(filename: string) {
	return path.extname(filename) === SUPPORTED_EXTENSION;
}

function processFile(filename: string, config: Config) {
	console.log("Processing", filename);

	const arch = config.arch || "aarch64";

	const resolved = path.resolve(filename);
	const lib_path = resolve_lib(resolved);
	config.lib = lib_path;

	let startTime = performance.now();

	let input = join(path.resolve(filename), config.lib);
	const parsed = parse(input);
	// TODO: If verbose flag
	// console.log("Parsed");

	let errors = parsed.errors;
	const ok = !errors.length;

	if (!ok) {
		console.log(render_errors(input, errors));
		return;
	}

	// TODO: If verbose flag
	// console.log("Built");
	const result = build(parsed.root, { arch, audit: config.audit });

	const dir = path.dirname(filename);
	const basename = path.basename(filename, ".echo");
	const buildDir = path.join(dir, "build");
	if (!fs.existsSync(buildDir)) {
		fs.mkdirSync(buildDir, { recursive: true });
	}
	const ext = arch === "aarch64" ? ".s" : ".c";
	const headerfile = path.join(buildDir, "main.h");
	const codefile = path.join(buildDir, basename + ext);
	const outfile = path.join(buildDir, basename);
	fs.writeFileSync(headerfile, result.headers);
	fs.writeFileSync(codefile, result.code);

	const compileTime = performance.now();
	console.log(`Created ${codefile} in ${(compileTime - startTime).toFixed(2)}ms`);
	console.log("");

	startTime = performance.now();

	const audit_obj = config.audit ? compile_audit_runtime(config, resolved, buildDir) : undefined;
	const link_inputs = audit_obj ? `${codefile} ${audit_obj}` : `${codefile}`;
	execSync(`clang -o ${outfile} ${link_inputs}`);
	execSync(outfile, { stdio: "inherit" });

	const runTime = performance.now();
	console.log("");
	console.log("");
	console.log(`Completed in ${(runTime - startTime).toFixed(2)}ms`);
}
