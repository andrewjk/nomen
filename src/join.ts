import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// HACK: Just loading everything into a single big source file for now
// TODO: Retain line numbers!!
const DEFAULT_LIB_REL = "../../core/src";

// Computed lazily, not at module load: this module is also bundled into the
// editor extension (CommonJS), where `import.meta.url` is undefined and
// evaluating it would crash activation. Only `join()` needs it.
let default_lib_path: string | undefined;
function fallback_lib_path(): string {
	if (default_lib_path === undefined) {
		try {
			default_lib_path = path.resolve(
				path.dirname(fileURLToPath(import.meta.url)),
				DEFAULT_LIB_REL,
			);
		} catch {
			default_lib_path = "";
		}
	}
	return default_lib_path;
}

export interface JoinOptions {
	/** True when `entry` is a `*.test.nm` compile: the program's `src/` module
	 * is pulled in too, with its `main` functions stripped (the test harness
	 * supplies its own `main`, so the program's would collide). */
	for_test?: boolean;
}

// The program's `src/` module dir for the current test compile, if any. Files
// under it get their `main` stripped by `add_source`.
let test_src_dir: string | undefined;

export default function join(
	entry_file_path: string,
	lib_path?: string,
	options?: JoinOptions,
): string {
	const folder_path = path.dirname(entry_file_path);
	const file_path = path.basename(entry_file_path);
	const inputs = new Map();
	// Every real file in the graph, by resolved absolute path. A file is
	// marked BEFORE its imports are processed, so self-imports and mutual
	// imports (A imports B imports A) terminate instead of recursing
	// forever — each file is walked exactly once.
	const visited = new Set<string>();
	const resolved_lib_path = lib_path ? path.resolve(lib_path, "src") : fallback_lib_path();
	// Key the entry as `./<name>` so that a sibling's `import <name>` (which
	// resolves to the same key) finds it already inlined instead of re-reading
	// and duplicating the entry's declarations.
	const for_test = options?.for_test ?? file_path.endsWith(".test.nm");
	const prev_test_src_dir = test_src_dir;
	test_src_dir = for_test ? resolve_src_module(folder_path) : undefined;
	try {
		add_source(folder_path, `./${file_path}`, inputs, resolved_lib_path, visited);
		// A folder is a module: every sibling `.nm` file's `pub` declarations are
		// visible to the entry without an explicit `import`, mirroring how the
		// System library concatenates its own files. Pull in every other file in
		// the entry's folder so cross-file references resolve. A `*.test.nm`
		// entry is exempt: test files are STANDALONE programs (the harness adds
		// its own `main`), so gathering their folder's siblings would inline the
		// whole suite into every file's build — quadratic compile weight (for a
		// 24-file suite the joined source grew 4x) and an OOM for `nomen test`.
		// Tests import what they need explicitly (plus the `src/` module via
		// `for_test` below), exactly like the standalone `*.test.nm` copies the
		// run path compiles.
		if (!for_test) {
			gather_module_siblings(folder_path, file_path, inputs, resolved_lib_path, visited);
		}
		// Declarations one directory up are visible too — a file in `src/utils/`
		// sees the `.nm` files directly in `src/`. Mirrors the editor extension,
		// which does the same so diagnostics match what the compiler accepts.
		gather_module_parent(folder_path, file_path, inputs, resolved_lib_path, visited);
		// A `*.test.nm` file can use the program's `pub` declarations: pull in
		// the `src/` module (with `main` stripped) so tests call the real code.
		if (test_src_dir) gather_src_module(test_src_dir, inputs, resolved_lib_path, visited);
	} finally {
		test_src_dir = prev_test_src_dir;
	}
	return Array.from(inputs.values()).join("\n\n") + "\n";
}

function gather_module_siblings(
	folder_path: string,
	entry_file: string,
	inputs: Map<string, string>,
	lib_path: string,
	visited: Set<string>,
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
		add_source(folder_path, import_file_path, inputs, lib_path, visited);
	}
}

function gather_module_parent(
	folder_path: string,
	entry_file: string,
	inputs: Map<string, string>,
	lib_path: string,
	visited: Set<string>,
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
		add_source(parent_path, `./${name}`, inputs, lib_path, visited);
	}
}

/** The program's `src/` module dir for a file in `entry_dir`, if one exists. */
export function resolve_src_module(entry_dir: string): string | undefined {
	for (const dir of [path.join(entry_dir, "src"), path.join(path.dirname(entry_dir), "src")]) {
		try {
			if (fs.statSync(dir).isDirectory()) return dir;
		} catch {
			// no such dir — keep looking
		}
	}
	return undefined;
}

function gather_src_module(
	src_dir: string,
	inputs: Map<string, string>,
	lib_path: string,
	visited: Set<string>,
): void {
	let names: string[];
	try {
		names = fs.readdirSync(src_dir);
	} catch {
		return;
	}
	for (const name of names.sort()) {
		if (!name.endsWith(".nm")) continue;
		const import_file_path = `./${name}`;
		if (inputs.has(import_file_path)) continue;
		add_source(src_dir, import_file_path, inputs, lib_path, visited);
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
	visited: Set<string>,
) {
	let source_path = path.resolve(folder_path, file_path);

	if (!fs.existsSync(source_path)) {
		const lib_source_path = path.resolve(lib_path, file_path);
		if (fs.existsSync(lib_source_path)) {
			source_path = lib_source_path;
		}
	}

	// Mark BEFORE processing imports: a file that imports itself (directly,
	// or through a mutual-import cycle) is already in the graph when its
	// own import line resolves, so the walk terminates. Also dedupes a file
	// reached by two different keys (gathered under one name, imported
	// under another).
	if (visited.has(source_path)) return;
	visited.add(source_path);

	let source: string;
	try {
		source = fs.readFileSync(source_path, "utf8");
	} catch {
		throw new Error(
			`joiner: 'import ${file_path.replace(/^\.\/|\.\w+$/g, "")}' does not resolve from ${folder_path}`,
		);
	}
	// In a test compile the harness supplies `main`, so drop the program's own
	// `main` declarations (its other `pub` declarations stay visible).
	if (test_src_dir && is_within(source_path, test_src_dir)) {
		source = strip_main_functions(source);
	}
	source = `// file://${source_path}\n` + source;

	source = source.replaceAll(/^import(.*)$/gm, (match, name) => {
		const trimmed = name.trim();
		// `import System` and `import System::<namespace>` are library imports,
		// resolved at parse time via resolve_linked_types — not files to inline.
		if (trimmed === "System" || trimmed.startsWith("System::")) return match;
		// Segments may carry whitespace (older formatter versions emitted
		// `Types:: Diff`), so trim each one rather than the whole path.
		const segments: string[] = trimmed
			.split("::")
			.map((s: string) => s.trim())
			.filter((s: string) => s.length > 0);
		if (!segments.length) return "";
		const rel = segments.join("/");
		// A trailing segment may name a namespace directory (`import Types`
		// for `./Types/*.nm`) rather than a module file — inline every file
		// in it, mirroring how `import System` pulls a whole namespace and
		// how a folder is itself a module (see gather_module_siblings).
		let is_dir = false;
		const dir_path = path.resolve(folder_path, rel);
		try {
			is_dir = fs.statSync(dir_path).isDirectory();
		} catch {
			// Not a directory — fall through to file resolution below.
		}
		if (is_dir) {
			// A file importing the namespace folder it lives in is a self-import:
			// everything in that folder is already gathered as siblings.
			if (is_within(source_path, dir_path)) {
				console.error(
					`[joiner] warning: ${source_path} imports its own namespace ('${trimmed}') — skipped`,
				);
				return "";
			}
			let names: string[];
			try {
				names = fs.readdirSync(dir_path);
			} catch {
				return "";
			}
			for (const name of names.sort()) {
				if (!name.endsWith(".nm")) continue;
				const import_file_path = `./${rel}/${name}`;
				if (!inputs.has(import_file_path)) {
					add_source(folder_path, import_file_path, inputs, lib_path, visited);
				}
			}
			return "";
		}
		const import_file_path = `./${rel}.nm`;
		const target = path.resolve(folder_path, import_file_path);
		if (target === source_path) {
			console.error(`[joiner] warning: ${source_path} imports itself — skipped`);
			return "";
		}
		if (!inputs.has(import_file_path)) {
			add_source(folder_path, import_file_path, inputs, lib_path, visited);
		}
		return "";
	});

	inputs.set(file_path, source);
}

function is_within(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Remove every top-level `func main` (optionally `pub`) declaration, body and
 * all. Used when compiling a test: the generated harness provides `main`, so
 * the program's own `main` would collide as a duplicate declaration.
 */
export function strip_main_functions(source: string): string {
	let result = "";
	let i = 0;
	const n = source.length;
	let depth = 0;
	while (i < n) {
		if (depth === 0 && is_main_declaration(source, i)) {
			i = skip_main_function(source, i);
			continue;
		}
		const ch = source[i];
		result += ch;
		if (ch === '"' || ch === "'") {
			i++;
			let escaped = false;
			while (i < n) {
				const c = source[i];
				result += c;
				i++;
				if (escaped) escaped = false;
				else if (c === "\\") escaped = true;
				else if (c === ch) break;
			}
			continue;
		}
		if (ch === "{") depth++;
		if (ch === "}") depth--;
		i++;
	}
	return result;
}

// Is `i` at the start of a line declaring `(pub )?func main`?
function is_main_declaration(source: string, i: number): boolean {
	if (i > 0 && source[i - 1] !== "\n") return false;
	const line_end = source.indexOf("\n", i);
	const line = line_end === -1 ? source.slice(i) : source.slice(i, line_end);
	return /^\s*(pub\s+)?func\s+main\b/.test(line);
}

// Skip from a `main` declaration past its body (or arrow body), returning the
// index of the first character to keep.
function skip_main_function(source: string, i: number): number {
	const n = source.length;
	let line_end = i;
	while (line_end < n && source[line_end] !== "\n") line_end++;
	const decl_line = source.slice(i, line_end);
	const brace = decl_line.indexOf("{");
	if (brace === -1) {
		if (decl_line.includes("=>")) {
			// Arrow body: the whole expression is on the declaration line.
			return line_end < n ? line_end + 1 : n;
		}
		// Braces on a later line — scan forward for the opening `{`.
		let j = line_end;
		while (j < n && source[j] !== "{") {
			if (source[j] === '"' || source[j] === "'") {
				const quote = source[j];
				j++;
				while (j < n && source[j] !== quote) j++;
			}
			j++;
		}
		if (j >= n) return n;
		return skip_balanced_block(source, j);
	}
	return skip_balanced_block(source, i + brace);
}

// Skip the balanced `{ ... }` block whose opening brace is at `brace`, then the
// trailing newline.
function skip_balanced_block(source: string, brace: number): number {
	const n = source.length;
	let depth = 0;
	let j = brace;
	while (j < n) {
		const ch = source[j];
		if (ch === '"' || ch === "'") {
			const quote = ch;
			j++;
			let escaped = false;
			while (j < n) {
				const c = source[j++];
				if (escaped) escaped = false;
				else if (c === "\\") escaped = true;
				else if (c === quote) break;
			}
			continue;
		}
		if (ch === "{") depth++;
		if (ch === "}") {
			depth--;
			if (depth === 0) {
				j++;
				while (j < n && (source[j] === "\r" || source[j] === "\n")) j++;
				return j;
			}
		}
		j++;
	}
	return n;
}
