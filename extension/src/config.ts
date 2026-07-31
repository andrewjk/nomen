import fs from "node:fs";
import path from "node:path";

import type { FormatOptions } from "../../src/format.ts";

// Strip `//` line and `/* */` block comments so a .jsonc file parses as JSON.
export function parse_jsonc(text: string): any {
	return JSON.parse(text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""));
}

/**
 * Read the `format` options from the nearest package.jsonc at or above `from`.
 *
 * The search walks up the directory tree like the compiler's library
 * resolution: a package.jsonc in the current folder wins, otherwise a
 * `core/package.jsonc` is used. Returns `{}` when nothing is configured, so the
 * formatter falls back to its defaults.
 */
export function load_format_options(from: string): Partial<FormatOptions> {
	let dir = fs.lstatSync(from).isDirectory() ? from : path.dirname(from);
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
