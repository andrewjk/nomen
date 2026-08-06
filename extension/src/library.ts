import fs from "node:fs";
import path from "node:path";

import * as vscode from "vscode";

import { get_library } from "../../src/lib.ts";
import type { Library } from "../../src/lib.ts";

const library_cache = new Map<string, Library>();

// Path to the System library bundled with the CLI, discovered once on
// activation by shelling out to `nomen lib-path`. Undefined until then; null
// after a failed lookup so we don't keep retrying.
let bundled_lib_dir: string | undefined | null = undefined;

export function set_bundled_lib_dir(dir: string | undefined): void {
	bundled_lib_dir = dir;
}

export function bundled_lib_resolved(): boolean {
	return bundled_lib_dir !== undefined;
}

export function workspace_folder_of(uri: vscode.Uri): string {
	return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? "";
}

export function load_library(uri: vscode.Uri): Library | undefined {
	const lib_dir = resolve_lib_dir(uri);
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

export function resolve_lib_dir(uri: vscode.Uri): string | undefined {
	let dir = path.dirname(uri.fsPath);
	for (let i = 0; i < 20; i++) {
		const config_path = path.join(dir, "package.jsonc");
		if (fs.existsSync(config_path)) {
			try {
				const raw = fs
					.readFileSync(config_path, "utf8")
					.replace(/\/\/.*$/gm, "")
					.replace(/\/\*[\s\S]*?\*\//g, "");
				const parsed = JSON.parse(raw);
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

	const workspace_folder = workspace_folder_of(uri);
	if (workspace_folder) {
		const fallback = path.join(workspace_folder, "core");
		if (fs.existsSync(path.join(fallback, "package.jsonc"))) return fallback;
	}
	// Last resort: the System library bundled with the CLI. `bundled_lib_dir`
	// is populated once on activation by running `nomen lib-path`.
	if (bundled_lib_dir && fs.existsSync(path.join(bundled_lib_dir, "package.jsonc"))) {
		return bundled_lib_dir;
	}
	return undefined;
}
