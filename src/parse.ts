import path from "node:path";

import check from "./check.ts";
import { attach_doc_comments } from "./doc_comments.ts";
import type { Library } from "./lib.ts";
import RootNode from "./nodes/RootNode.ts";
import parse_statement from "./parse/parse_statement.ts";
import type ParseStatus from "./parse/ParseStatus.ts";
import tokenize from "./tokenize.ts";
import type CompileError from "./types/CompileError.ts";
import type ParseResult from "./types/ParseResult.ts";

export default function parse(source: string, library?: Library, file_path?: string): ParseResult {
	const user_source_length = source.length;
	if (library) {
		source = resolve_linked_types(source, library, file_path);
	}

	const tokens = tokenize(source);

	const root = new RootNode();

	const status: ParseStatus = {
		tokens,
		i: 0,
		stack: [root],
		// TODO: Should be the base namespace, from module.config, folder structure, file name
		namespace: "",
		errors: [],
	};

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

	// No point type checking if the syntax is busted
	if (status.errors.length) {
		return {
			ok: false,
			root,
			errors: format_errors(source, status.errors),
		};
	}

	const checked = check(root);

	return {
		ok: !checked.errors.length,
		root,
		errors: format_errors(source, checked.errors),
	};
}

function mark_library_nodes(root: RootNode, boundary: number): void {
	// The System library source is appended after the user source, so any
	// declaration starting at or past `boundary` belongs to the library.
	// Walk the tree and flag functions (including struct methods) and structs.
	function walk(node: any): void {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		const type = node.node_type as string | undefined;
		if (type === "func") {
			if ((node.start as number) >= boundary) node.is_library = true;
			if (node.statements) walk(node.statements);
			if (node.allocations) walk(node.allocations);
			return;
		}
		if (type === "struct") {
			if ((node.start as number) >= boundary) node.is_library = true;
			if (node.functions) for (const f of node.functions) walk(f);
			if (node.fields) walk(node.fields);
		}
		if (node.statements) walk(node.statements);
		if (node.allocations) walk(node.allocations);
	}
	walk(root);
}

function resolve_linked_types(source: string, library: Library, file_path?: string): string {
	const tokens = tokenize(source);

	let has_system_import = false;
	const namespace_imports = new Set<string>();
	for (let i = 0; i < tokens.length - 1; i++) {
		if (tokens[i].value === "import" && tokens[i + 1].value === "System") {
			has_system_import = true;
			// Check for `import System / <namespace>` (tokens: import, System, /, name)
			if (
				i + 3 < tokens.length &&
				tokens[i + 2].value === "/" &&
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
		if (["struct", "trait", "enum", "bitset"].includes(tokens[i].value)) {
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

	// Auto-import any library types referenced in the source
	for (const token of tokens) {
		if (user_defined.has(token.value)) continue;
		if (library.types.has(token.value) && !BASE_TYPES.includes(token.value)) {
			needed.add(token.value);
		}
	}

	// `spawn` and `async` rely on the Task runtime even when Task isn't named
	// directly (the build emits Task compound literals at spawn sites).
	if (tokens.some((t) => t.value === "spawn" || t.value === "async")) {
		needed.add("Task");
		needed.add("Sendable");
	}
	// A named `async` block (`async pool { }`) binds a Nursery variable in
	// scope without naming the type, so pull the Nursery struct in whenever
	// `async` is used. See ASYNC.md escape hatch.
	if (tokens.some((t) => t.value === "async")) {
		needed.add("Nursery");
	}

	const resolved = resolve_types_with_deps(
		needed,
		library,
		is_library_file ? file_path : undefined,
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
	"int",
	"uint",
	"int8",
	"uint8",
	"float",
	"char",
	"string",
	"Array",
	"Console",
	"bool",
];

// Map a module-path import (e.g. `System/Controls/Geometry`) to the type names
// declared in that module, so the dependency walker can pull the module's source
// in. The library indexes types by *type name*, not module path, so an imported
// module whose name doesn't match one of its own types (e.g. `Geometry`, which
// declares `Size`/`Frame`/…) would otherwise never be pulled in.
function module_type_names(dep: string, library: Library): string[] | undefined {
	const base = dep.includes("/") ? dep.split("/").pop()! : dep;
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
): string {
	const resolved = new Set<string>();
	const pushed = new Set<string>();
	const result: string[] = [];

	function resolve(name: string) {
		if (resolved.has(name)) return;
		resolved.add(name);
		const entry = library.types.get(name);
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
		// duplicate every struct/func it defines.
		if (self_path && path.resolve(entry.path) === path.resolve(self_path)) return;
		// A file declaring multiple types contributes the same source for each;
		// push it only once to avoid duplicate definitions.
		if (!pushed.has(entry.source)) {
			pushed.add(entry.source);
			result.push(entry.source);
		}
	}

	for (const name of needed) {
		resolve(name);
	}

	return result.join("\n");
}

function format_errors(source: string, errors: CompileError[]) {
	errors = errors.sort((a, b) => a.start - b.start).filter((e) => e.start >= 0);

	// Add line and column information to errors
	let line = 1;
	let lastLineStart = 0;
	for (let i = 0, e = 0; i < source.length, e < errors.length; i++) {
		if (source[i] === "\n") {
			line += 1;
			lastLineStart = i + 1;
		}
		while (e < errors.length && errors[e].start === i) {
			errors[e].line = line;
			errors[e].column = i - lastLineStart + 1;
			e += 1;
		}
	}

	return errors;
}
