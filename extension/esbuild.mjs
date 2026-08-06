import * as esbuild from "esbuild";

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
	// In CJS output esbuild's `import.meta` shim leaves `.url` undefined, so
	// `import.meta.url` (used by bundled src/join.ts) would crash the extension
	// at load. Point it at a banner-defined global carrying the real URL.
	define: { "import.meta.url": "import_meta_url" },
	banner: {
		js: "const import_meta_url = require('url').pathToFileURL(__filename).href;",
	},
	sourcemap: true,
	minify,
	logLevel: "info",
};

if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
} else {
	await esbuild.build(options);
}
