import fs from "node:fs";
import path from "node:path";

export interface LibraryConfig {
	name: string;
	exports: Record<string, string>;
}

export interface Library {
	name: string;
	source: string;
	types: Map<string, LibraryType>;
}

export interface LibraryType {
	name: string;
	source: string;
	deps: string[];
}

export function read_library_config(lib_dir: string): LibraryConfig {
	const config_path = path.join(lib_dir, "package.jsonc");
	const raw = fs.readFileSync(config_path, "utf8");
	const json = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
	return JSON.parse(json) as LibraryConfig;
}

export function resolve_export_files(lib_dir: string, pattern: string): string[] {
	const base = pattern.replace(/\/?\*$/, "").replace(/^\.\//, "");
	const src_dir = path.resolve(lib_dir, base);
	if (!fs.existsSync(src_dir)) return [];
	const files = fs
		.readdirSync(src_dir)
		.filter((f) => f.endsWith(".echo"))
		.sort()
		.map((f) => path.join(src_dir, f));
	return files;
}

const FILE_ORDER = [
	"Disposable",
	"Stringable",
	"int",
	"uint",
	"int8",
	"uint8",
	"float",
	"char",
	"String",
	"Array",
	"Console",
	"Math",
	"bool",
];

function get_file_priority(file_path: string): number {
	const name = path.basename(file_path, ".echo");
	const idx = FILE_ORDER.indexOf(name);
	if (idx >= 0) return idx;
	return FILE_ORDER.length;
}

function extract_deps(source: string): string[] {
	const deps: string[] = [];
	for (const line of source.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("import ")) {
			deps.push(trimmed.slice(7).trim());
		} else if (trimmed.startsWith("pub struct ") || trimmed.startsWith("struct ")) {
			const colon_idx = trimmed.indexOf(":");
			if (colon_idx >= 0) {
				const after_colon = trimmed.slice(colon_idx + 1).trim();
				const trait_name = after_colon.split(/\s|<|{/)[0];
				if (trait_name) deps.push(trait_name);
			}
			break;
		} else if (trimmed.startsWith("pub trait ") || trimmed.startsWith("trait ")) {
			break;
		} else if (trimmed.length > 0 && !trimmed.startsWith("//")) {
			break;
		}
	}
	return deps;
}

function extract_type_name(source: string): string | null {
	for (const line of source.split("\n")) {
		const trimmed = line.trim();
		const struct_match = trimmed.match(/^pub struct (\w+)/);
		if (struct_match) return struct_match[1];
		const trait_match = trimmed.match(/^pub trait (\w+)/);
		if (trait_match) return trait_match[1];
	}
	return null;
}

function build_type_map(files: string[]): Map<string, LibraryType> {
	const types = new Map<string, LibraryType>();
	for (const f of files) {
		const source = fs.readFileSync(f, "utf8");
		const deps = extract_deps(source);
		const name = extract_type_name(source);
		if (name) {
			types.set(name, { name, source, deps });
		}
	}
	return types;
}

export function resolve_types(needed: Set<string>, types: Map<string, LibraryType>): string {
	const resolved = new Set<string>();
	const result: string[] = [];

	function resolve(name: string) {
		if (resolved.has(name)) return;
		const entry = types.get(name);
		if (!entry) return;
		for (const dep of entry.deps) {
			resolve(dep);
		}
		resolved.add(name);
		result.push(entry.source);
	}

	const ordered = [...needed].sort((a, b) => {
		const ai = FILE_ORDER.indexOf(a);
		const bi = FILE_ORDER.indexOf(b);
		return (ai >= 0 ? ai : FILE_ORDER.length) - (bi >= 0 ? bi : FILE_ORDER.length);
	});

	for (const name of ordered) {
		resolve(name);
	}

	return result.join("\n");
}

export function build_library(lib_dir: string): Library {
	const config = read_library_config(lib_dir);

	let all_files: string[] = [];
	for (const pattern of Object.values(config.exports)) {
		all_files = all_files.concat(resolve_export_files(lib_dir, pattern));
	}

	all_files.sort((a, b) => get_file_priority(a) - get_file_priority(b));

	const source = all_files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
	const types = build_type_map(all_files);

	return {
		name: config.name,
		source,
		types,
	};
}

const library_cache = new Map<string, Library>();

export function get_library(lib_dir: string): Library {
	const cached = library_cache.get(lib_dir);
	if (cached) return cached;
	const lib = build_library(lib_dir);
	library_cache.set(lib_dir, lib);
	return lib;
}
