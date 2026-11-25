import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

// The TextMate grammar lives in the shared `grammars/` package (also used by
// nomen-shiki and the site). Copy it into `syntaxes/` so `contributes.grammars`
// and `vsce package` (which only ships files under this folder) find it.
const here = path.dirname(fileURLToPath(import.meta.url));
const grammar_src = path.join(here, "..", "grammars", "nomen.tmLanguage.json");
const grammar_dest = path.join(here, "syntaxes", "nomen.tmLanguage.json");
function copy_grammar() {
	fs.mkdirSync(path.dirname(grammar_dest), { recursive: true });
	fs.copyFileSync(grammar_src, grammar_dest);
}
copy_grammar();

const watch = process.argv.includes("--watch");
const minify = process.argv.includes("--minify");

/** @type {import("esbuild").BuildOptions} */
const options = {
	entryPoints: ["src/extension.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outfile: "dist/extension.js",
	external: ["vscode"],
	sourcemap: true,
	minify,
	logLevel: "info",
};

if (watch) {
	fs.watchFile(grammar_src, { interval: 500 }, copy_grammar);
	const ctx = await esbuild.context(options);
	await ctx.watch();
} else {
	await esbuild.build(options);
}
