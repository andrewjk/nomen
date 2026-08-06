#! /usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import chokidar from "chokidar";

import build, { default_platform } from "../../src/build.ts";
import { format_source, type FormatOptions } from "../../src/format.ts";
import join from "../../src/join.ts";
import { get_library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import { parse_args, print_help, type Args } from "./args.ts";
import { run_docs } from "./docs.ts";
import render_errors, { render_warnings } from "./format_errors.ts";
import { find_bundled, run_init } from "./init.ts";
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

console.error("\n~ NOMEN ~\n");

const args: Args = parse_args();
const command = args.command;

try {
	// `nomen init <name>` scaffolds a new project under ./<name>.
	if (command === "init") {
		run_init(args.name);
		process.exit(0);
	}

	// `nomen lib-path` prints the absolute path to the System library
	// bundled with this CLI. Used by tooling (e.g. the VS Code extension)
	// to locate the standard library for projects without a local one.
	if (command === "lib-path") {
		const lib = find_bundled("core");
		if (lib) {
			process.stdout.write(lib + "\n");
			process.exit(0);
		}
		console.log("No bundled System library found alongside the CLI.");
		process.exit(1);
	}

	// `nomen docs` generates markdown documentation instead of compiling.
	if (command === "docs") {
		run_docs(args.in);
		process.exit(0);
	}

	// `nomen test` discovers and runs every `*.test.nm` file under --in (or
	// the cwd), compiling each into a Tester harness and reporting results.
	if (command === "test") {
		const root = args.in ?? process.cwd();
		const filter = args.filter ? new RegExp(args.filter) : undefined;
		const arch = args.arch ?? "aarch64";
		const ok = runTests(root, { arch, filter });
		process.exit(ok ? 0 : 1);
	}

	// `nomen format` re-indents and tidies every .nm file under a folder.
	if (command === "format") {
		const root = args.in ?? process.cwd();
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
				if (!args.check) fs.writeFileSync(file, result.code);
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
		print_help();
		process.exit(1);
	}

	// An explicit --in wins; otherwise discover what to compile from the
	// working folder — a package.jsonc `entry`, or a lone .nm file.
	args.in = args.in ?? resolve_input();
	if (!args.in) {
		process.exit(0);
	}
	// For an explicit --in, build next to whatever was passed (the folder
	// itself, or the file's folder). Discovery cases set build_root themselves.
	if (!build_root) {
		build_root = fs.lstatSync(args.in).isDirectory() ? args.in : path.dirname(args.in);
	}

	if (fs.existsSync(args.in)) {
		let config: Config = { arch: "aarch64", platform: default_platform() };
		// Load the config from a file
		if (args.config && fs.existsSync(args.config)) {
			config = JSON.parse(fs.readFileSync(args.config, "utf-8"));
		}
		// Overwrite with args
		if (args.arch) config.arch = args.arch as "aarch64" | "c";
		if (args.platform) config.platform = args.platform;
		if (args.lib) config.lib = args.lib;
		if (args.audit) config.audit = args.audit;
		if (args.audit_runtime) config.audit_runtime = args.audit_runtime;

		// Is the --in path a folder
		if (fs.lstatSync(args.in).isDirectory()) {
			if (args.watch) {
				watchPath(args.in, config, mode);
			} else {
				processFolder(args.in, config, mode);
			}
		} else {
			// Process the supplied file
			const extname = path.extname(args.in);
			if (shouldProcessFile(args.in)) {
				// NOTE: We get add notifications for all watched files immediately
				// TODO: Is this the case on Windows etc too?
				if (args.watch) {
					watchPath(args.in, config, mode);
				} else {
					processFile(args.in, config, mode);
				}
			} else {
				console.log("Unsupported file type: " + extname);
			}
		}
	} else {
		console.log("Path not found: " + args.in);
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
	// Nothing local — fall back to the System library bundled with the CLI.
	return find_bundled("core");
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
