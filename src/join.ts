import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// HACK: Just loading everything into a single big source file for now
// TODO: Retain line numbers!!
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LIB_PATH = path.resolve(__dirname, "../../core/src");

export default function join(entry_file_path: string, lib_path?: string): string {
	const folder_path = path.dirname(entry_file_path);
	const file_path = path.basename(entry_file_path);
	const inputs = new Map();
	const resolved_lib_path = lib_path ? path.resolve(lib_path, "src") : DEFAULT_LIB_PATH;
	// Key the entry as `./<name>` so that a sibling's `import <name>` (which
	// resolves to the same key) finds it already inlined instead of re-reading
	// and duplicating the entry's declarations.
	add_source(folder_path, `./${file_path}`, inputs, resolved_lib_path);
	// A folder is a module: every sibling `.nm` file's `pub` declarations are
	// visible to the entry without an explicit `import`, mirroring how the
	// System library concatenates its own files. Pull in every other file in
	// the entry's folder so cross-file references resolve.
	gather_module_siblings(folder_path, file_path, inputs, resolved_lib_path);
	// Declarations one directory up are visible too — a file in `src/utils/`
	// sees the `.nm` files directly in `src/`. Mirrors the editor extension,
	// which does the same so diagnostics match what the compiler accepts.
	gather_module_parent(folder_path, file_path, inputs, resolved_lib_path);
	return Array.from(inputs.values()).join("\n\n") + "\n";
}

function gather_module_siblings(
	folder_path: string,
	entry_file: string,
	inputs: Map<string, string>,
	lib_path: string,
): void {
	let names: string[];
	try {
		names = fs.readdirSync(folder_path);
	} catch {
		return;
	}
	// A folder is a module whose sibling `.nm` files are visible to the entry
	// without explicit imports. But when the entry is itself a standalone
	// program (declares `func main`), siblings that ALSO declare `func main`
	// are independent programs sharing a directory, not part of the same
	// module — merging them would collide on `main`. Skip those siblings.
	const entry_is_program = has_main(inputs.get(`./${entry_file}`) ?? "");
	for (const name of names.sort()) {
		if (!name.endsWith(".nm")) continue;
		if (name === entry_file) continue;
		const import_file_path = `./${name}`;
		if (inputs.has(import_file_path)) continue;
		if (entry_is_program) {
			const sibling_path = path.resolve(folder_path, name);
			try {
				if (has_main(fs.readFileSync(sibling_path, "utf8"))) continue;
			} catch {
				// unreadable sibling — fall through and let add_source handle it
			}
		}
		add_source(folder_path, import_file_path, inputs, lib_path);
	}
}

function gather_module_parent(
	folder_path: string,
	entry_file: string,
	inputs: Map<string, string>,
	lib_path: string,
): void {
	// `.nm` files one directory up are visible to the entry too (a file in
	// `src/utils/` sees `src/*.nm`), mirroring the editor extension. Skip
	// parent files that declare `func main` when the entry is itself a
	// program, the same way sibling gathering does.
	const parent_path = path.dirname(folder_path);
	if (parent_path === folder_path) return;
	let names: string[];
	try {
		names = fs.readdirSync(parent_path);
	} catch {
		return;
	}
	const entry_is_program = has_main(inputs.get(`./${entry_file}`) ?? "");
	for (const name of names.sort()) {
		if (!name.endsWith(".nm")) continue;
		if (inputs.has(`./${name}`)) continue;
		if (entry_is_program) {
			try {
				if (has_main(fs.readFileSync(path.resolve(parent_path, name), "utf8"))) continue;
			} catch {
				// unreadable — fall through and let add_source handle it
			}
		}
		// Resolve relative to the parent so the file's own imports also look
		// there; key as `./<name>` so an explicit `import <name>` dedupes.
		add_source(parent_path, `./${name}`, inputs, lib_path);
	}
}

function has_main(source: string): boolean {
	return /\bfunc\s+main\b/.test(source);
}

function add_source(
	folder_path: string,
	file_path: string,
	inputs: Map<string, string>,
	lib_path: string,
) {
	let source_path = path.resolve(folder_path, file_path);

	if (!fs.existsSync(source_path)) {
		const lib_source_path = path.resolve(lib_path, file_path);
		if (fs.existsSync(lib_source_path)) {
			source_path = lib_source_path;
		}
	}

	let source = `// file://${source_path}\n`;

	source += fs.readFileSync(source_path, "utf8");

	source = source.replaceAll(/^import(.*)$/gm, (match, name) => {
		const trimmed = name.trim();
		// `import System` and `import System/<namespace>` are library imports,
		// resolved at parse time via resolve_linked_types — not files to inline.
		if (trimmed === "System" || trimmed.startsWith("System/")) return match;
		const import_file_path = `./${trimmed}.nm`;
		if (!inputs.has(import_file_path)) {
			add_source(folder_path, import_file_path, inputs, lib_path);
		}
		return "";
	});

	inputs.set(file_path, source);
}
