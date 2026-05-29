#! /usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import chokidar from "chokidar";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";

import build from "../../src/build";
import join from "../../src/join";
import parse from "../../src/parse";
import type Config from "./types/Config";

const SUPPORTED_EXTENSION = ".echo";

//(async () => {
try {
	console.log("\n~ ECHO CLI ~\n");

	const options = yargs(hideBin(process.argv))
		.usage("Usage: echo --in [file/folder]")
		.option("in", {
			alias: "i",
			describe: "Input file or folder",
			type: "string",
			demandOption: true,
		})
		.option("out", {
			alias: "o",
			describe: "Output file",
			type: "string",
			demandOption: false,
		})
		.option("config", {
			alias: "c",
			describe: "The path to a config file",
			type: "string",
			demandOption: false,
		})
		.option("watch", {
			alias: "w",
			describe: "Whether to watch for file changes",
			type: "boolean",
			demandOption: false,
		})
		.option("arch", {
			alias: "a",
			describe: "Target architecture (c or aarch64)",
			type: "string",
			default: "aarch64",
		})
		.help(true)
		.parseSync();

	// Does the --in path exist
	if (fs.existsSync(options.in)) {
		// Does the --config path exist
		let config: Config = { arch: options.arch as "c" | "aarch64" };
		if (options.config && fs.existsSync(options.config)) {
			// TODO: Support a js/ts config file as well as JSON
			//config = await import(options.config);
			config = JSON.parse(fs.readFileSync(options.config, "utf-8"));
		}

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
	yargs.showHelp();
}
//})();

function watchPath(path: string, config: Config) {
	chokidar.watch(path).on("all", (event, path) => {
		//console.log("Change", event, path);
		// TODO: Remove deleted files etc
		if (shouldProcessFile(path)) {
			processFile(path, config);
		}
	});
}

function processFolder(folder: string, config: Config) {
	const dir = fs.opendirSync(folder);
	let dirent;
	while ((dirent = dir.readSync()) !== null) {
		if (shouldProcessFile(dirent.name)) {
			processFile(path.join(folder, dirent.name), config);
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

	let startTime = performance.now();

	let input = join(path.resolve(filename));
	const parsed = parse(input);
	// TODO: If verbose flag
	// console.log("Parsed");

	let errors = parsed.errors.filter((f) => f.message !== "Function not found: printf");
	const ok = !errors.length;

	if (!ok) {
		console.log("\nERRORS\n======");
		for (let error of errors) {
			let slice = input.slice(0, error.start);
			let line = 1;
			let last_line_index = 0;
			for (let i = 0; i < slice.length; i++) {
				if (input[i] === "\n") {
					line += 1;
					last_line_index = i;
				}
			}
			console.log(`${line},${error.start - last_line_index - 1}: ${error.message}`);
		}
		console.log("======");
	}

	const result = build(parsed.root, { arch });
	// TODO: If verbose flag
	// console.log("Built");

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

	if (arch === "aarch64") {
		execSync(`clang -o ${outfile} ${codefile}`);
	} else {
		execSync(`clang -o ${outfile} ${codefile}`);
	}
	execSync(outfile, { stdio: "inherit" });

	const runTime = performance.now();
	console.log("");
	console.log("");
	console.log(`Completed in ${(runTime - startTime).toFixed(2)}ms`);
}
