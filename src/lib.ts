import fs from "node:fs";
import path from "node:path";

export interface LibraryConfig {
	name: string;
	exports: Record<string, string>;
}

export interface Library {
	name: string;
	source: string;
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

export function build_library(lib_dir: string): Library {
	const config = read_library_config(lib_dir);

	let all_files: string[] = [];
	for (const pattern of Object.values(config.exports)) {
		all_files = all_files.concat(resolve_export_files(lib_dir, pattern));
	}

	all_files.sort((a, b) => get_file_priority(a) - get_file_priority(b));

	const source = all_files.map((f) => fs.readFileSync(f, "utf8")).join("\n");

	return {
		name: config.name,
		source,
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
