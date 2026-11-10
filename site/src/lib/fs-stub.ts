/**
 * The Worker has no filesystem. The compiler imports `node:fs` at module scope
 * for the Node-only paths (`get_library`, `#embed_file`, a C-backend debug
 * dump); the REPL uses none of them, so the import is aliased to this stub and
 * fails loudly if those paths are ever reached.
 *
 * Torpor's own modules also import this module (`import fs from "node:fs"` and
 * `import { promises } from "node:fs"`); the named exports keep those bundles
 * resolvable without pulling Node built-ins into the Worker.
 */

function unavailable(): never {
	throw new Error("Filesystem access is not available in this environment");
}

export const readFileSync = unavailable;
export const writeFileSync = unavailable;
export const appendFileSync = unavailable;
export const copyFileSync = unavailable;
export const mkdirSync = unavailable;
export const lstatSync = unavailable;
export const statSync = unavailable;
export const existsSync = () => false;
export const readdirSync = () => [];

export const promises = {
	readFile: unavailable,
	writeFile: unavailable,
	appendFile: unavailable,
	copyFile: unavailable,
	mkdir: unavailable,
	readdir: unavailable,
	rm: unavailable,
};

const fs = {
	readFileSync,
	writeFileSync,
	appendFileSync,
	copyFileSync,
	mkdirSync,
	lstatSync,
	statSync,
	existsSync,
	readdirSync,
	promises,
};

export default fs;
