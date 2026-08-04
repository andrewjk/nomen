#! /usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import chokidar from "chokidar";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";

import build, { default_platform } from "../../src/build.ts";
import { format_source, type FormatOptions } from "../../src/format.ts";
import join from "../../src/join.ts";
import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import { run_docs } from "./docs.ts";
import render_errors, { render_warnings } from "./format_errors.ts";
import { runTests } from "./test.ts";
import type Config from "./types/Config.ts";

const SUPPORTED_EXTENSION = ".nm";

type Mode = "check" | "build" | "run";

// Strip `//` line and `/* */` block comments so a .jsonc file parses as JSON.
function parse_jsonc(text: string): any {
	return JSON.parse(text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""));
}

/** Read the `format` options from the nearest package.jsonc above `start`. */
function load_format_options(start: string): Partial<FormatOptions> {
	let dir = fs.lstatSync(start).isDirectory() ? start : path.dirname(start);
	for (let i = 0; i < 20; i++) {
		const config_path = path.join(dir, "package.jsonc");
		if (fs.existsSync(config_path)) {
			try {
				const parsed = parse_jsonc(fs.readFileSync(config_path, "utf8"));
				if (parsed.format) return parsed.format as Partial<FormatOptions>;
			} catch {
				// ignore malformed package.jsonc and keep searching
			}
		}
		const lib_config = path.join(dir, "core", "package.jsonc");
		if (fs.existsSync(lib_config)) {
			try {
				const parsed = parse_jsonc(fs.readFileSync(lib_config, "utf8"));
				if (parsed.format) return parsed.format as Partial<FormatOptions>;
			} catch {
				// ignore
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return {};
}

/** Recursively collect every `.nm` file under `folder`. */
function collect_nm_files(folder: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
		const full = path.join(folder, entry.name);
		if (entry.isDirectory()) out.push(...collect_nm_files(full));
		else if (shouldProcessFile(entry.name)) out.push(full);
	}
	return out;
}

// The folder whose `build/` subdirectory receives compiler output. Set during
// input resolution: the --in folder, the .nm file's folder, or — for
// package.jsonc discovery — the package folder (cwd), not the entry's folder.
let build_root: string | undefined;

console.log("\n~ NOMEN ~\n");

const parser = yargs(hideBin(process.argv))
	.usage(
		"Usage:\n" +
			"  nomen run --in [file/folder]    Parse, check, build and run a program\n" +
			"  nomen build --in [file/folder]   Parse, check and build (no run)\n" +
			"  nomen check --in [file/folder]   Parse and check only\n" +
			"  nomen format [--in folder]       Reformat every .nm file\n" +
			"  nomen docs [--in file]           Generate markdown documentation",
	)
	.command("run", "Parse, check, build and run a program")
	.command("build", "Parse, check and build (compile and link, but do not run)")
	.command("check", "Parse and check only")
	.command("format", "Reformat every .nm file")
	.command("docs", "Generate markdown documentation")
	.command("test", "Discover and run *.test.nm files with the Tester harness")
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
	.option("filter", {
		alias: "f",
		describe: "Only run test files whose path matches this regex",
		type: "string",
	})
	.option("arch", {
		alias: "a",
		describe: "Target architecture (aarch64 or c)",
		type: "string",
		default: "aarch64",
	})
	.option("platform", {
		alias: "p",
		describe: "Target platform (macos, ios, linux, android, windows, web)",
		type: "string",
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
	.option("check", {
		describe: "For `nomen format`: report files that would change without writing them",
		type: "boolean",
	})
	.help(true);

const options = parser.parseSync();

const command = options._[0];

try {
	// `nomen docs` generates markdown documentation instead of compiling.
	if (command === "docs") {
		run_docs(typeof options.in === "string" ? options.in : undefined);
		process.exit(0);
	}

	// `nomen test` discovers and runs every `*.test.nm` file under --in (or
	// the cwd), compiling each into a Tester harness and reporting results.
	if (command === "test") {
		const root = options.in ?? process.cwd();
		const filter = typeof options.filter === "string" ? new RegExp(options.filter) : undefined;
		const arch = (options.arch as string | undefined) ?? "aarch64";
		const ok = runTests(root, { arch, filter });
		process.exit(ok ? 0 : 1);
	}

	// `nomen format` re-indents and tidies every .nm file under a folder.
	if (command === "format") {
		const root = options.in ?? process.cwd();
		const format_options = load_format_options(root);
		const files = collect_nm_files(root);
		let changed = 0;
		for (const file of files) {
			const source = fs.readFileSync(file, "utf8");
			const result = format_source(source, format_options);
			if (result.unsafe) {
				console.log(`Skipped ${file}: ${result.unsafe}`);
				continue;
			}
			if (result.changed) {
				if (!options.check) fs.writeFileSync(file, result.code);
				changed += 1;
				console.log(`Formatted ${file}`);
			}
		}
		console.log(`\nFormatted ${changed} of ${files.length} file(s).`);
		process.exit(0);
	}

	// `run`, `build` and `check` all start from parsed + checked source; `run`
	// also links and executes, `build` stops after linking, `check` stops after
	// checking. An unknown (or missing) command prints the help instead.
	let mode: Mode | undefined;
	if (command === "run") mode = "run";
	else if (command === "build") mode = "build";
	else if (command === "check") mode = "check";

	if (!mode) {
		parser.showHelp("log");
		process.exit(1);
	}

	// An explicit --in wins; otherwise discover what to compile from the
	// working folder — a package.jsonc `entry`, or a lone .nm file.
	options.in = options.in ?? resolve_input();
	if (!options.in) {
		process.exit(0);
	}
	// For an explicit --in, build next to whatever was passed (the folder
	// itself, or the file's folder). Discovery cases set build_root themselves.
	if (!build_root) {
		build_root = fs.lstatSync(options.in).isDirectory() ? options.in : path.dirname(options.in);
	}

	if (fs.existsSync(options.in)) {
		let config: Config = { arch: "aarch64", platform: default_platform() };
		// Load the config from a file
		if (options.config && fs.existsSync(options.config)) {
			config = JSON.parse(fs.readFileSync(options.config, "utf-8"));
		}
		// Overwrite with args
		if (options.arch) config.arch = options.arch as "aarch64" | "c";
		if (options.platform) config.platform = options.platform as string;
		if (options.lib) config.lib = options.lib;
		if (options.audit) config.audit = options.audit;
		if (options["audit-runtime"]) config.audit_runtime = options["audit-runtime"];

		// Is the --in path a folder
		if (fs.lstatSync(options.in).isDirectory()) {
			if (options.watch) {
				watchPath(options.in, config, mode);
			} else {
				processFolder(options.in, config, mode);
			}
		} else {
			// Process the supplied file
			const extname = path.extname(options.in);
			if (shouldProcessFile(options.in)) {
				// NOTE: We get add notifications for all watched files immediately
				// TODO: Is this the case on Windows etc too?
				if (options.watch) {
					watchPath(options.in, config, mode);
				} else {
					processFile(options.in, config, mode);
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

function resolve_input(): string | undefined {
	const cwd = process.cwd();

	// a) A package.jsonc with an `entry` field (the project's main file).
	const config_path = path.join(cwd, "package.jsonc");
	if (fs.existsSync(config_path)) {
		try {
			const raw = fs.readFileSync(config_path, "utf8");
			const json = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
			const parsed = JSON.parse(json);
			if (parsed.entry) {
				build_root = cwd;
				return path.resolve(cwd, parsed.entry);
			}
		} catch {
			// ignore malformed package.jsonc and fall through
		}
	}

	// b) A single .nm file directly in the working folder.
	let nm_files: string[] = [];
	try {
		nm_files = fs.readdirSync(cwd).filter((f) => f.endsWith(".nm"));
	} catch {
		// unreadable working folder
	}
	if (nm_files.length === 1) {
		build_root = cwd;
		return path.resolve(cwd, nm_files[0]);
	}
	if (nm_files.length > 1) {
		console.log(
			`Found ${nm_files.length} .nm files in ${cwd}. Specify which to run with --in:\n  ` +
				nm_files.join("\n  "),
		);
		return undefined;
	}

	console.log(
		"Nothing to compile. Pass --in <file/folder>, or run inside a folder with a package.jsonc or a .nm file.",
	);
	return undefined;
}

function resolve_lib(file_path: string): string | undefined {
	let dir = path.dirname(path.resolve(file_path));
	for (let i = 0; i < 20; i++) {
		const config_path = path.join(dir, "package.jsonc");
		if (fs.existsSync(config_path)) {
			try {
				const raw = fs.readFileSync(config_path, "utf8");
				const json = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
				const parsed = JSON.parse(json);
				if (parsed.imports?.System) {
					return path.resolve(dir, parsed.imports.System);
				}
			} catch {
				// ignore malformed package.jsonc and keep searching
			}
		}
		const lib_config = path.join(dir, "core", "package.jsonc");
		if (fs.existsSync(lib_config)) return path.join(dir, "core");
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
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

function watchPath(p: string, config: Config, mode: Mode) {
	chokidar.watch(p).on("all", (event, filePath) => {
		if (shouldProcessFile(filePath)) {
			processFile(filePath, config, mode);
		}
	});
}

function processFolder(folder: string, config: Config, mode: Mode) {
	const dir = fs.opendirSync(folder);
	let dirent;
	while ((dirent = dir.readSync()) !== null) {
		if (shouldProcessFile(dirent.name)) {
			processFile(path.join(folder, dirent.name), config, mode);
			// @ts-ignore
			let _ = fs.watch;
		}
	}
	dir.closeSync();
}

function shouldProcessFile(filename: string) {
	return path.extname(filename) === SUPPORTED_EXTENSION;
}

function processFile(filename: string, config: Config, mode: Mode) {
	console.log("Processing", filename);

	const arch = config.arch || "aarch64";
	const platform = config.platform || default_platform();

	const resolved = path.resolve(filename);
	if (!config.lib) {
		config.lib = resolve_lib(resolved);
	}

	let startTime = performance.now();

	const resolved_path = path.resolve(filename);
	const input = join(resolved_path, config.lib);
	const library = config.lib ? get_library(config.lib) : undefined;
	const parsed = parse(input, library, resolved_path);

	let errors = parsed.errors;

	if (errors.length) {
		console.log(render_errors(input, errors));
		return;
	}

	// Warnings come out of the parse/check phase, so every mode reports them.
	if (parsed.warnings.length) console.log(render_warnings(input, parsed.warnings));

	// `check` stops after parsing and checking — no building, linking or running.
	if (mode === "check") {
		const checkTime = performance.now();
		console.log(`Checked in ${(checkTime - startTime).toFixed(2)}ms`);
		return;
	}

	const result = build(parsed.root, { arch, platform, audit: config.audit });

	if (result.errors && result.errors.length > 0) {
		console.log(render_errors(input, result.errors));
		return;
	}

	const basename = path.basename(filename, ".nm");
	const buildDir = path.join(build_root ?? path.dirname(filename), "build");
	if (!fs.existsSync(buildDir)) {
		fs.mkdirSync(buildDir, { recursive: true });
	}
	const ext = arch === "aarch64" ? ".s" : platform === "macos" || platform === "ios" ? ".m" : ".c";
	const headerfile = path.join(buildDir, "main.h");
	const codefile = path.join(buildDir, basename + ext);
	const outfile = path.join(buildDir, basename);
	fs.writeFileSync(headerfile, result.headers);
	fs.writeFileSync(codefile, result.code);

	let companionfile: string | undefined;
	if (result.companion) {
		const comp_ext = platform === "macos" || platform === "ios" ? ".m" : ".c";
		companionfile = path.join(buildDir, basename + "_companion" + comp_ext);
		fs.writeFileSync(companionfile, result.companion);
	}

	const compileTime = performance.now();
	console.log(`Created ${codefile} in ${(compileTime - startTime).toFixed(2)}ms`);
	console.log("");

	// `build` links the executable but does not run it; `run` links and runs.
	startTime = performance.now();

	const audit_obj = config.audit ? compile_audit_runtime(config, resolved, buildDir) : undefined;
	let link_inputs = codefile;
	if (companionfile) link_inputs += ` ${companionfile}`;
	if (audit_obj) link_inputs += ` ${audit_obj}`;
	const framework_flags =
		platform === "macos" || platform === "ios"
			? " -framework CoreGraphics -framework Foundation -framework AppKit -lobjc"
			: "";
	execSync(`clang -o ${outfile} ${link_inputs}${framework_flags}`);

	if (mode === "build") {
		const buildTime = performance.now();
		console.log(`Built ${outfile} in ${(buildTime - startTime).toFixed(2)}ms`);
		return;
	}

	execSync(outfile, { stdio: "inherit" });

	const runTime = performance.now();
	console.log("");
	console.log("");
	console.log(`Completed in ${(runTime - startTime).toFixed(2)}ms`);
}
