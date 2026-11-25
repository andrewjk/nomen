import fs from "node:fs";
import path from "node:path";

import { get_library } from "../../src/lib.ts";
import type { Library } from "../../src/lib.ts";
import { parse_jsonc } from "./config.ts";

const library_cache = new Map<string, Library>();

/**
 * Where the System library lives for files that have no local one. The
 * server runs inside the CLI, so this is the copy bundled with it (or the
 * repo's `core/` in a dev checkout) — no `nomen lib-path` round trip needed.
 */
let bundled_lib_dir: string | undefined;

export function set_bundled_lib_dir(dir: string | undefined): void {
	bundled_lib_dir = dir;
}

/** Workspace folders the client opened, longest first so nested folders win. */
let workspace_folders: string[] = [];

export function set_workspace_folders(folders: string[]): void {
	workspace_folders = [...folders].sort((a, b) => b.length - a.length);
}

export function workspace_folder_of(file_path: string): string {
	for (const folder of workspace_folders) {
		const rel = path.relative(folder, file_path);
		if (!rel.startsWith("..") && !path.isAbsolute(rel)) return folder;
	}
	return "";
}

export function load_library(file_path: string): Library | undefined {
	const lib_dir = resolve_lib_dir(file_path);
	if (!lib_dir) return undefined;
	const cached = library_cache.get(lib_dir);
	if (cached) return cached;
	try {
		const library = get_library(lib_dir);
		library_cache.set(lib_dir, library);
		return library;
	} catch {
		return undefined;
	}
}

/** Drop the cached libraries that `changed` files belong to (all of them
 *  when a package.jsonc changed, since that can re-point `imports.System`).
 *  Returns whether anything was dropped. */
export function forget_libraries_for(changed: string[]): boolean {
	let dropped = false;
	for (const file of changed) {
		if (path.basename(file) === "package.jsonc") {
			dropped = library_cache.size > 0 || dropped;
			library_cache.clear();
			return dropped;
		}
		for (const dir of library_cache.keys()) {
			const rel = path.relative(dir, file);
			if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
			library_cache.delete(dir);
			dropped = true;
		}
	}
	return dropped;
}

export function resolve_lib_dir(file_path: string): string | undefined {
	let dir = path.dirname(file_path);
	for (let i = 0; i < 20; i++) {
		const config_path = path.join(dir, "package.jsonc");
		if (fs.existsSync(config_path)) {
			try {
				const parsed = parse_jsonc(fs.readFileSync(config_path, "utf8"));
				if (parsed.imports?.System) return path.resolve(dir, parsed.imports.System);
			} catch {
				// ignore malformed package.jsonc and keep searching
			}
		}
		// Also check for a `core/` directory at this level (the standard library itself).
		const lib_config = path.join(dir, "core", "package.jsonc");
		if (fs.existsSync(lib_config)) return path.join(dir, "core");
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	const workspace_folder = workspace_folder_of(file_path);
	if (workspace_folder) {
		const fallback = path.join(workspace_folder, "core");
		if (fs.existsSync(path.join(fallback, "package.jsonc"))) return fallback;
	}
	// Last resort: the System library bundled with the CLI.
	if (bundled_lib_dir && fs.existsSync(path.join(bundled_lib_dir, "package.jsonc"))) {
		return bundled_lib_dir;
	}
	return undefined;
}
