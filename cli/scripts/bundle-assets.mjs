// Copies repo-level assets into the cli/ package so they ship with the
// published `nomen-lang` npm package:
//
//   ../core           -> ./core           (the System standard library)
//   ../NOMEN_AGENTS.md -> ./NOMEN_AGENTS.md (project template -> AGENTS.md)
//
// `nomen init <name>` reads these at runtime to populate a new project.
// In dev (`npm run go`), init.ts also falls back to the repo layout directly,
// so this script running first is only required for the bundled CLI.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "..");
const repo = path.resolve(cli, "..");

const pairs = [
	[path.join(repo, "core"), path.join(cli, "core")],
	[path.join(repo, "NOMEN_AGENTS.md"), path.join(cli, "NOMEN_AGENTS.md")],
];

for (const [src, dest] of pairs) {
	if (!fs.existsSync(src)) {
		console.error(`bundle-assets: source not found: ${src}`);
		process.exit(1);
	}
	const stat = fs.statSync(src);
	if (stat.isDirectory()) {
		fs.cpSync(src, dest, { recursive: true });
	} else {
		fs.copyFileSync(src, dest);
	}
	console.log(`bundle-assets: ${path.relative(repo, src)} -> ${path.relative(cli, dest)}`);
}
