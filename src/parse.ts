import fs from "node:fs";
import path from "node:path";

import add_error from "./add_error.ts";
import check from "./check.ts";
import { collect_spawned_starts } from "./check/utils/comptime.ts";
import { ns_is_ancestor_or_self } from "./check/utils/namespaces.ts";
import { attach_doc_comments } from "./doc_comments.ts";
import { library_dir_prefixes, type Library } from "./lib.ts";
import RootNode from "./nodes/RootNode.ts";
import parse_statement from "./parse/parse_statement.ts";
import type ParseStatus from "./parse/ParseStatus.ts";
import tokenize from "./tokenize.ts";
import type CompileError from "./types/CompileError.ts";
import type ParseResult from "./types/ParseResult.ts";
import type Token from "./types/Token.ts";

export default function parse(
	source: string,
	library?: Library,
	file_path?: string,
	options?: {
		allow_user_raw?: boolean;
		allow_internal?: boolean;
		/** Compile target for `#if META.arch` folding (defaults: C backend,
		 *  host platform — see check()). The CLI passes its own config so
		 *  `nomen check`/`build`/`run`/`test` agree on which arms survive. */
		arch?: string;
		platform?: string;
	},
): ParseResult {
	let user_source_length = source.length;
	if (library) {
		source = resolve_linked_types(source, library, file_path);
		// When the file being checked is itself part of the System library,
		// treat ALL of its declarations as trusted library internals.
		// Otherwise checking a core data-structure file directly spuriously
		// flags its own Buffer index accesses ("constraint cannot be
		// verified") and re-warns on its methods — the same code is trusted
		// when pulled in as a dependency of a user program.
		if (file_path && is_within(file_path, library.dir)) {
			user_source_length = 0;
		}
	}

	const tokens = tokenize(source);

	// The file table (docs/SCOPING.md): index 0 is the entry context; every
	// `// file://` marker in the source opens the next file. Declarations are
	// stamped with their file's id and namespace after parsing.
	const table = build_file_table(tokens, library, file_path);

	const root = new RootNode();

	const status: ParseStatus = {
		tokens,
		i: 0,
		stack: [root],
		// TODO: Should be the base namespace, from module.config, folder structure, file name
		namespace: "",
		qualified_paths: [],
		library,
		errors: [],
		allow_user_raw: options?.allow_user_raw,
		embed_root: embed_root_for(file_path),
	};
	// `unsafe` lockdown: only the appended System library source (tokens at
	// or past the user source's end) may declare unsafe functions/blocks.
	// Undefined with no library — the feature is then rejected everywhere.
	if (library) {
		status.unsafe_boundary = user_source_length;
	}

	parse_statement(status);

	// Attach `/** ... **/` doc comments to the declarations they precede, so
	// downstream tools (doc generation, editor hovers) can reach them.
	attach_doc_comments(root, source);

	// Mark nodes defined in the appended System library source so the checker
	// can trust library internals (which maintain their own bounds invariants)
	// while still requiring user code to satisfy (or guard) index constraints.
	if (library) {
		mark_library_nodes(root, user_source_length);
	}

	// Attribute every declaration to its file and namespace, and compute what
	// each import grants — BEFORE validating qualified paths, whose coverage
	// checks consult the stamped imports (docs/SCOPING.md).
	const imports_by_file = stamp_file_namespaces(root, table, library, file_path);
	root.file_paths = table.paths;
	root.file_namespaces = table.namespaces;

	// Qualified references (`Controls::Button`) flatten to bare names during
	// parsing; validate their namespace prefixes against the library index and
	// against what the referencing file can see.
	if (status.qualified_paths.length) {
		validate_qualified_paths(status, library, table, imports_by_file);
	}

	// No point type checking if the syntax is busted
	if (status.errors.length) {
		return {
			ok: false,
			root,
			errors: format_errors(source, status.errors, root),
			warnings: [],
		};
	}

	const checked = check(root, {
		allow_internal: options?.allow_internal,
		library_boundary: library ? user_source_length : undefined,
		owning_library_types: library
			? new Set([...library.types.values()].filter((t) => t.is_owning).map((t) => t.name))
			: undefined,
		arch: options?.arch,
		platform: options?.platform,
	});

	return {
		ok: !checked.errors.length,
		root,
		errors: format_errors(source, checked.errors, root),
		warnings: format_errors(source, checked.warnings, root),
	};
}

/**
 * The compilation's file table (docs/SCOPING.md): index 0 is the entry
 * context; one further entry per `// file://` marker in the source. The
 * parser stamps declarations with their file id and namespace; the checker
 * reads the same table off the RootNode.
 */
interface FileTable {
	paths: string[];
	namespaces: string[];
	/** Source offsets where each marked file begins, in ascending order. */
	marker_starts: { start: number; id: number }[];
}

/** The file id a source offset belongs to (last marker at-or-before it). */
function file_id_at(table: FileTable, start: number): number {
	let id = 0;
	for (const marker of table.marker_starts) {
		if (marker.start <= start) id = marker.id;
		else break;
	}
	return id;
}

/**
 * The namespace of a directory (docs/SCOPING.md): `"System"`,
 * `"System::Controls"`, ... for directories under the library's `System/`
 * root; the entry-relative directory path (`""`, `"Blah"`, `"Blah::Sub"`)
 * for program files; `".."` for anything gathered from outside the entry's
 * directory tree.
 */
function derive_dir_namespace(
	dir: string,
	library: Library | undefined,
	entry_dir?: string,
): string {
	if (library) {
		const system_root = path.resolve(library.dir, "System");
		const rel = path.relative(system_root, dir);
		if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
			const parts = rel === "" ? [] : rel.split(path.sep);
			return ["System", ...parts].join("::");
		}
	}
	if (!entry_dir) return "";
	const rel = path.relative(entry_dir, dir);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return "..";
	const parts = rel === "" ? [] : rel.split(path.sep);
	return parts.join("::");
}

function build_file_table(
	tokens: Token[],
	library: Library | undefined,
	file_path?: string,
): FileTable {
	const entry_dir = file_path ? path.dirname(path.resolve(file_path)) : undefined;
	const table: FileTable = {
		paths: [file_path ? path.resolve(file_path) : ""],
		namespaces: [entry_dir ? derive_dir_namespace(entry_dir, library, entry_dir) : ""],
		marker_starts: [],
	};
	for (const token of tokens) {
		if (token.value !== "file_marker" || !token.file) continue;
		const id = table.paths.length;
		table.paths.push(token.file);
		table.namespaces.push(derive_dir_namespace(path.dirname(token.file), library, entry_dir));
		table.marker_starts.push({ start: token.i, id });
	}
	return table;
}

/**
 * What an import grants (docs/SCOPING.md): the namespace of its resolved
 * target's directory. `import System` grants `"System"`; `import
 * System::Controls` grants `"System::Controls"`; a module-file import
 * (`import System::Text::Regex`) grants the file's directory namespace
 * (`"System::Text"`). Imports never grant a namespace's descendants.
 */
function import_granted_namespace(
	name: string,
	owner_path: string,
	library: Library | undefined,
	entry_dir?: string,
): string {
	const segments = name.split("::").filter((s) => s.length > 0);
	if (!segments.length) return "";
	// `System`-rooted imports resolve against the library layout regardless
	// of who imports them — there is exactly one library, and inline parses
	// (no file path) still need the correct grant.
	if (library && segments[0] === "System") {
		// Namespace imports only — module files are invisible to imports
		// (docs/SCOPING.md); validate_import_path rejects file paths.
		const system_root = path.resolve(library.dir, "System");
		const base = segments.slice(1);
		if (!base.length) return "System";
		const dir = path.resolve(system_root, ...base);
		if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
			return derive_dir_namespace(dir, library, entry_dir);
		}
		// Unknown path — validate_import_path already reported the typo.
		return name;
	}
	const owner_in_library = !!library && owner_path !== "" && is_within(owner_path, library.dir);
	if (library && owner_in_library) {
		// A library file's plain import (`import Task`) resolves against the
		// library's System root — directory or module file.
		const system_root = path.resolve(library.dir, "System");
		const dir = path.resolve(system_root, ...segments);
		if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
			return derive_dir_namespace(dir, library, entry_dir);
		}
		const file = `${dir}.nm`;
		if (fs.existsSync(file)) {
			return derive_dir_namespace(path.dirname(file), library, entry_dir);
		}
		return name;
	}
	if (entry_dir) {
		const base = path.resolve(entry_dir, ...segments);
		if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
			return derive_dir_namespace(base, library, entry_dir);
		}
		const file = `${base}.nm`;
		if (fs.existsSync(file)) {
			return derive_dir_namespace(path.dirname(file), library, entry_dir);
		}
	}
	// Unresolvable from here (the joiner inlines these files elsewhere) —
	// grant the spelled path as its own namespace.
	return segments.join("::");
}

const STAMPED_NODE_TYPES = new Set([
	"func",
	"struct",
	"trait",
	"enum",
	"bitset",
	"declare",
	"extend",
	"import",
]);

/**
 * Stamp every declaration with its file id and namespace (docs/SCOPING.md),
 * and record what each import grants per owning file. Runs after parsing,
 * before qualified-path validation — whose coverage checks consult the
 * stamped imports.
 */
function stamp_file_namespaces(
	root: RootNode,
	table: FileTable,
	library: Library | undefined,
	file_path?: string,
): Map<number, Set<string>> {
	const entry_dir = file_path ? path.dirname(path.resolve(file_path)) : undefined;
	function is_node(value: unknown): boolean {
		return (
			!!value &&
			typeof value === "object" &&
			typeof (value as { node_type?: unknown }).node_type === "string"
		);
	}
	function walk(node: any): void {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (STAMPED_NODE_TYPES.has(node.node_type)) {
			const id = file_id_at(table, node.start);
			node.file_id = id;
			node.namespace = table.namespaces[id] ?? "";
		}
		for (const key of Object.keys(node)) {
			if (key === "parent" || key === "scope") continue;
			const value = node[key];
			if (Array.isArray(value)) {
				for (const item of value) if (is_node(item)) walk(item);
			} else if (is_node(value)) {
				walk(value);
			}
		}
	}
	// The root is the entry context (file 0): checks that run with only the
	// root on the stack — signature checks before a function is pushed —
	// must resolve to the entry namespace and its imports, not the
	// empty-namespace fallback.
	root.namespace = table.namespaces[0] ?? "";
	root.file_id = 0;
	walk(root);

	const imports_by_file = new Map<number, Set<string>>();
	for (const imp of root.imports) {
		const id = imp.file_id ?? 0;
		imp.granted_namespace = import_granted_namespace(
			imp.name,
			table.paths[id] ?? "",
			library,
			entry_dir,
		);
		let set = imports_by_file.get(id);
		if (!set) {
			set = new Set();
			imports_by_file.set(id, set);
		}
		set.add(imp.granted_namespace);
	}
	return imports_by_file;
}

/**
 * Validate the namespace prefixes of qualified references recorded while
 * parsing (`Controls::Button`, `System::Text::Regex`). Two checks per
 * reference: the prefix must exist (a mistyped path (`Control::Button`)
 * would otherwise silently resolve nothing), and the referencing file must
 * be able to SEE the namespace — its own namespace chain (ancestors) or its
 * imports (docs/SCOPING.md).
 */
function validate_qualified_paths(
	status: ParseStatus,
	library: Library | undefined,
	table: FileTable,
	imports_by_file: Map<number, Set<string>>,
): void {
	if (!library) return;
	const dir_prefixes = library_dir_prefixes(library);
	for (const ref of status.qualified_paths) {
		const prefix_segments = ref.segments.slice(0, -1);
		if (!prefix_segments.length) continue;
		const ns = qualified_prefix_namespace(
			prefix_segments,
			library,
			dir_prefixes,
			status,
			ref.start,
		);
		if (ns === undefined) continue;
		const file_id = file_id_at(table, ref.start);
		const accessor_ns = table.namespaces[file_id] ?? "";
		if (ns_is_ancestor_or_self(ns, accessor_ns)) continue;
		if (imports_by_file.get(file_id)?.has(ns)) continue;
		add_error(status, `Namespace ${ns} is not imported`, ref.start);
	}
}

/**
 * The namespace a qualified reference's prefix names: the longest DIRECTORY
 * prefix when the path is library-rooted — a namespace's visibility boundary
 * is its directory, so `Controls::Geometry::Size` names `System::Controls` —
 * or the spelled path for the program's own namespaces. Returns undefined
 * when a library-rooted path doesn't exist in the layout (a typo); the
 * `Unknown namespace` error has been reported in that case.
 */
function qualified_prefix_namespace(
	segments: string[],
	library: Library,
	dir_prefixes: Set<string>,
	status: ParseStatus,
	start: number,
): string | undefined {
	const lib_rooted = segments[0] === "System" || dir_prefixes.has(segments[0]);
	if (lib_rooted) {
		const rel = segments[0] === "System" ? segments.slice(1).join("/") : segments.join("/");
		// A qualified prefix names a NAMESPACE — a directory of the library.
		// Module files are invisible to the path: `Controls::Geometry::Size`
		// does not resolve through Geometry.nm (the type is `Controls::Size`),
		// and a file-segment spelling is a loud error rather than a silent
		// collapse (docs/SCOPING.md).
		if (!dir_prefixes.has(rel)) {
			add_error(status, `Unknown namespace: ${segments.join("::")}`, start);
			return undefined;
		}
		const parts = rel === "" ? [] : rel.split("/");
		return ["System", ...parts].join("::");
	}
	// The program's own namespace tree, spelled as-is.
	return segments.join("::");
}

function mark_library_nodes(root: RootNode, boundary: number): void {
	// The System library source is appended after the user source, so any
	// declaration starting at or past `boundary` belongs to the library.
	// Walk EVERY node reflectively (skipping parent/scope back-refs), not
	// just statement-list trees: a closure held by an expression — a lambda
	// in a declaration's value or a call argument — has no statements/alloc
	// path to it, and its inner declarations must be stamped too.
	function is_node(value: unknown): boolean {
		return (
			!!value &&
			typeof value === "object" &&
			typeof (value as { node_type?: unknown }).node_type === "string"
		);
	}
	function walk(node: any): void {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		const type = node.node_type as string | undefined;
		if (
			type === "func" ||
			type === "struct" ||
			type === "trait" ||
			type === "enum" ||
			type === "bitset" ||
			type === "declare"
		) {
			if ((node.start as number) >= boundary) node.is_library = true;
		}
		for (const key of Object.keys(node)) {
			if (key === "parent" || key === "scope") continue;
			const value = node[key];
			if (Array.isArray(value)) {
				for (const item of value) if (is_node(item)) walk(item);
			} else if (is_node(value)) {
				walk(value);
			}
		}
	}
	walk(root);
}

/**
 * The base directory for `#embed_file` paths: the package root (the nearest
 * enclosing directory with a package.jsonc), falling back to the entry
 * file's folder. No file path — undefined, so `#embed_file` resolves
 * against the process CWD. Exported for the library builder, which inlines
 * library-level embeds against each source file's own root (the
 * concatenated library source is parsed without a file path).
 */
export function embed_root_for(file_path?: string): string | undefined {
	if (!file_path) return undefined;
	let dir = path.dirname(path.resolve(file_path));
	for (let i = 0; i < 32; i++) {
		if (fs.existsSync(path.join(dir, "package.jsonc"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return path.dirname(path.resolve(file_path));
}

/**
 * Append the library source that `source` needs, exactly as `parse` does.
 * Exported so tooling (e.g. the editor extension) can reproduce the combined
 * source that node offsets refer to.
 */
export function resolve_linked_types(source: string, library: Library, file_path?: string): string {
	const tokens = tokenize(source);

	let has_system_import = false;
	const namespace_imports = new Set<string>();
	for (let i = 0; i < tokens.length - 1; i++) {
		if (tokens[i].value === "import" && tokens[i + 1].value === "System") {
			has_system_import = true;
			// Check for `import System::<namespace>` (tokens: import, System, ::, name)
			if (
				i + 3 < tokens.length &&
				tokens[i + 2].value === "::" &&
				tokens[i + 3].value !== undefined
			) {
				namespace_imports.add(tokens[i + 3].value);
			}
		}
	}

	// A file that lives inside the library package is itself part of the
	// library: at build time every library file is concatenated together, so
	// each one can reference every other one's `pub` declarations without an
	// explicit `import System`. Treat such files the same as an imported
	// module, but never re-inline the file being edited (that would duplicate
	// its own definitions).
	const is_library_file = !!file_path && is_within(file_path, library.dir);
	if (!has_system_import && !is_library_file) return source;

	// User-defined types shadow library types of the same name, so the library
	// version must not be pulled in (otherwise duplicate symbols at build time).
	const user_defined = new Set<string>();
	for (let i = 0; i < tokens.length; i++) {
		// `class` too: a user class shadowing a library CLASS (e.g. a sizing
		// example `class Box` against System's `Box<T>` — STRUCT_PLAN_3 B2)
		// must not pull the library declaration in alongside it.
		if (["struct", "class", "trait", "enum", "bitset"].includes(tokens[i].value)) {
			if (i + 1 < tokens.length) {
				user_defined.add(tokens[i + 1].value);
			}
		}
	}

	const needed = new Set<string>(BASE_TYPES);

	// Add types from explicitly imported namespaces
	for (const ns of namespace_imports) {
		const ns_types = library.namespaces.get(ns);
		if (ns_types) {
			for (const name of ns_types) {
				if (!user_defined.has(name)) {
					needed.add(name);
				}
			}
		}
	}

	// Auto-import any library types referenced in the source, plus any free
	// library FUNCTION the source calls. Free functions aren't types, so a
	// bare call like `parse_int("41")` used to resolve only when some other
	// token happened to reference a type from the same file (e.g. `Init`) —
	// a parameterless `main` calling nothing but `parse_int` failed with
	// "Function not found". Skip names the source declares itself (a user
	// `func`/method shadowing a library function must not pull the library's
	// declaration in alongside it — that would duplicate the declaration).
	const user_declared_funcs = new Set<string>();
	for (let i = 0; i < tokens.length - 1; i++) {
		if (tokens[i].value === "func" && /^\w+$/.test(tokens[i + 1].value)) {
			user_declared_funcs.add(tokens[i + 1].value);
		}
	}
	// Tokens belonging to an `import A::B::C` statement are path segments, not
	// type/function references. Scanning them lets a segment that happens to
	// share a name with an unrelated library type (`Text` in
	// `import System::Text::Regex` vs `Controls::Text`) drag that type — and
	// its whole dependency subtree (Controls::Text → Window → the ObjC
	// runtime) — into the build. Namespaces reached via `import System::<ns>`
	// are handled separately by the namespace scan above.
	const import_tokens = new Set<number>();
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].value !== "import") continue;
		import_tokens.add(i);
		let j = i + 1;
		if (j < tokens.length && /^\w+$/.test(tokens[j].value)) {
			import_tokens.add(j);
			j += 1;
			while (
				j + 1 < tokens.length &&
				tokens[j].value === "::" &&
				/^\w+$/.test(tokens[j + 1].value)
			) {
				import_tokens.add(j);
				import_tokens.add(j + 1);
				j += 2;
			}
		}
	}
	// Attribute NAMES are metadata, not references: `@Table("users")` must not
	// link Controls::Table (and its whole dependency subtree) just because the
	// lookup key shares a library type's name. The attribute grammar is
	// `@name` / `@name(value)`, comma-separated — the identifier token right
	// after `@` is always the name (`@` has no other spelling in the language;
	// a `@` inside a string literal is part of that token, not its own).
	const attribute_name_tokens = new Set<number>();
	for (let i = 0; i + 1 < tokens.length; i++) {
		if (tokens[i].value === "@" && /^[A-Za-z_]\w*$/.test(tokens[i + 1].value)) {
			attribute_name_tokens.add(i + 1);
		}
	}
	for (let i = 0; i < tokens.length; i++) {
		if (import_tokens.has(i)) continue;
		if (attribute_name_tokens.has(i)) continue;
		const token = tokens[i];
		if (user_defined.has(token.value)) continue;
		if (library.types.has(token.value) && !BASE_TYPES.includes(token.value)) {
			needed.add(token.value);
		} else if (library.functions.has(token.value) && !user_declared_funcs.has(token.value)) {
			needed.add(token.value);
		} else if (
			token.value === "!" &&
			i > 0 &&
			i < tokens.length - 1 &&
			(/^\w+$/.test(tokens[i - 1].value) || tokens[i - 1].value === "]") &&
			(/^\w+$/.test(tokens[i + 1].value) || tokens[i + 1].value === "[")
		) {
			// ERRORS_PLAN: the `T ! E` result form, the composed `T ! E1, E2`
			// set, and the anonymous error set `T ! [.case]` desugar to the
			// core `Result` generic at PARSE time — after this scan — so the
			// source never names `Result` as a token. A `!` between two words
			// or brackets is that form (the `]` case covers a tuple /
			// anonymous-enum success type; prefix `!x` sits behind an
			// operator or `(`; `!=` lexes as one compound), and pulling the
			// Result template for a stray lookalike is harmless: the generic
			// registers, its monos only materialize on use. Directly after
			// `out` it is the UNIT form (`out ! E`) — pull `UnitResult`.
			needed.add(tokens[i - 1].value === "out" ? "UnitResult" : "Result");
		} else if (
			token.value.length > 1 &&
			token.value.startsWith(":") &&
			!token.value.startsWith("::")
		) {
			// An interpolation format spec token (`\{expr:.2}` — tokenize.ts
			// emits the `:` + spec text as one token). The checker lowers a
			// spec'd argument into a `Format.*` call, so the Format module
			// must be linked even though the user source never names it.
			// (`::` is the namespace compound; a bare `:` is a constraint.)
			needed.add("Format");
		}
	}

	// A named `async` block (`async pool { }`, `async(timeout: N)`) binds a
	// Nursery capability WITHOUT the source naming the type — the binding is
	// compiler syntax, invisible to the token scan above by construction —
	// so `async` implies the Nursery import. (ASYNC.md: the old
	// `Thread`/`Fiber` → Task+Sendable special case is gone — pulling the
	// Thread/Fiber type pulls its declared library dependencies, `import
	// Task` in Thread.nm/Fiber.nm among them.)
	if (tokens.some((t) => t.value === "async")) {
		needed.add("Nursery");
	}

	const resolved = resolve_types_with_deps(
		needed,
		library,
		is_library_file ? file_path : undefined,
		user_defined,
	);
	if (!resolved) return source;

	return source + "\n" + resolved;
}

// Is `child` located inside `parent` (inclusive)? Both should be absolute.
function is_within(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const BASE_TYPES = [
	"Disposable",
	"Stringable",
	"Equatable",
	"Hashable",
	"int",
	"uint",
	"int8",
	"uint8",
	"int16",
	"uint16",
	"int32",
	"uint32",
	"int64",
	"uint64",
	"float",
	"float32",
	"float64",
	"char",
	"string",
	"Array",
	"Console",
	"bool",
];

// Map a module-path import (e.g. `System::Controls::Geometry`) to the type names
// declared in that module, so the dependency walker can pull the module's source
// in. The library indexes types by *type name*, not module path, so an imported
// module whose name doesn't match one of its own types (e.g. `Geometry`, which
// declares `Size`/`Frame`/…) would otherwise never be pulled in.
function module_type_names(dep: string, library: Library): string[] | undefined {
	const base = dep.includes("::") ? dep.split("::").pop()! : dep;
	const found: string[] = [];
	for (const [name, entry] of library.types) {
		const src_base = entry.path.split("/").pop()!.replace(/\.nm$/, "");
		if (src_base === base) found.push(name);
	}
	return found.length ? found : undefined;
}

function resolve_types_with_deps(
	needed: Set<string>,
	library: Library,
	self_path?: string,
	shadowed: Set<string> = new Set(),
): string {
	const resolved = new Set<string>();
	const pushed = new Set<string>();
	const result: string[] = [];

	function resolve(name: string) {
		if (resolved.has(name)) return;
		resolved.add(name);
		// A user declaration shadows the library type for transitive
		// dependencies too (a library file's `T ! E` pulls `Result`).
		if (shadowed.has(name)) return;
		const entry = library.types.get(name) ?? library.functions.get(name);
		if (!entry) {
			// `name` may be a module-path import rather than a type name. Expand
			// it to the module's declared types so its source gets pulled in.
			const mod_types = module_type_names(name, library);
			if (mod_types) {
				for (const t of mod_types) resolve(t);
			}
			return;
		}
		// Mark this node visited *before* descending so mutual deps
		// (Container ↔ LayoutLength, etc.) terminate instead of recursing.
		for (const dep of entry.deps) {
			resolve(dep);
		}
		// The file currently being edited already provides its own declarations
		// (as the live source), so never append its on-disk source — that would
		// duplicate every struct/func it defines. Likewise, a library file's
		// same-folder siblings are already inlined by the editor extension's
		// source map (which also pulls in free functions resolve doesn't
		// track), so never re-append those — doing so would duplicate every
		// sibling declaration.
		if (self_path) {
			const entry_path = path.resolve(entry.path);
			if (entry_path === path.resolve(self_path)) return;
			if (path.dirname(entry_path) === path.dirname(path.resolve(self_path))) return;
		}
		// A file declaring multiple types contributes the same source for each;
		// push it only once to avoid duplicate definitions.
		if (!pushed.has(entry.source)) {
			pushed.add(entry.source);
			// Precede each appended file with a `// file://` marker (matching
			// the joiner and the library builder) so the parser attributes its
			// declarations to the file — and namespace — they came from
			// (docs/SCOPING.md).
			result.push(`// file://${entry.path}\n${entry.source}`);
		}
	}

	for (const name of needed) {
		resolve(name);
	}

	return result.join("\n");
}

function format_errors(source: string, errors: CompileError[], root: RootNode) {
	errors = errors.sort((a, b) => a.start - b.start).filter((e) => e.start >= 0);

	// Two-location diagnostics: an error raised on generated code keeps the
	// generated node's offset — a position inside the `#for` arm's source —
	// which says nothing about WHICH loop unrolled it. Map the offsets of
	// `spawn_of`-stamped subtrees to their generating loop, decorate the
	// matching errors, and resolve the note's position alongside the
	// primary one (one scan, below).
	const spawned = collect_spawned_starts(root);
	for (const e of errors) {
		const at = spawned.get(e.start);
		if (at !== undefined) e.spawned_at = at;
	}

	// Add line and column information to errors (and to each spawned-at
	// note's offset).
	const spots: { offset: number; set: (line: number, column: number) => void }[] = [];
	for (const e of errors) {
		spots.push({
			offset: e.start,
			set: (l, c) => {
				e.line = l;
				e.column = c;
			},
		});
		if (e.spawned_at !== undefined) {
			spots.push({
				offset: e.spawned_at,
				set: (l, c) => {
					e.spawned_line = l;
					e.spawned_column = c;
				},
			});
		}
	}
	spots.sort((a, b) => a.offset - b.offset);
	let line = 1;
	let lastLineStart = 0;
	for (let i = 0, s = 0; i < source.length && s < spots.length; i++) {
		if (source[i] === "\n") {
			line += 1;
			lastLineStart = i + 1;
		}
		while (s < spots.length && spots[s].offset === i) {
			spots[s].set(line, i - lastLineStart + 1);
			s += 1;
		}
	}

	return errors;
}
