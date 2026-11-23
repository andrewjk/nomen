import built_in_types from "../../built_in_types.ts";

/**
 * Namespace-path helpers (docs/SCOPING.md). A namespace is a `::`-joined
 * directory path — `"System"`, `"System::Controls"` for library files;
 * `""`, `"Blah"`, `"Blah::Sub"` (entry-relative) or `".."` (a file gathered
 * from the parent directory) for program files. Visibility (pub / internal /
 * unmarked) is defined over these paths; both the parser (qualified-path
 * coverage) and the checker (declaration access) consult the same rules.
 */

/**
 * The namespace and its ancestors, nearest first: `"Blah::Sub"` chains to
 * `["Blah::Sub", "Blah", "", ".."]` — a file gathered from the parent
 * directory is the parent of the entry namespace, hence the trailing
 * `".."`. The library root `"System"` has no parent: the package boundary
 * sits above it, and user code (never inside the library's tree) reaches it
 * only through imports.
 */
export function ns_chain(ns: string): string[] {
	const chain = [ns];
	let cur = ns;
	while (cur !== ".." && cur !== "System") {
		const idx = cur.lastIndexOf("::");
		if (idx > 0) {
			cur = cur.slice(0, idx);
		} else if (cur === "") {
			cur = "..";
		} else {
			cur = "";
		}
		if (chain.includes(cur)) break;
		chain.push(cur);
	}
	return chain;
}

/** Whether `ancestor` is `ns` itself or one of its ancestors. */
export function ns_is_ancestor_or_self(ancestor: string, ns: string): boolean {
	return ns_chain(ns).includes(ancestor);
}

/**
 * The declaring namespace of a declaration node: its own stamped
 * `namespace`, falling back through its `scope` (a method's or mono clone's
 * scope is the struct it belongs to — stamped even when the clone itself
 * was synthesized without a stamp). Compiler-synthesized types (tuples,
 * anonymous structs) belong to no namespace: gates skip them.
 */
export function decl_namespace(node: unknown): string | undefined {
	const n = node as
		| {
				node_type?: string;
				name?: string;
				namespace?: string;
				scope?: { namespace?: string };
		  }
		| undefined;
	if (!n) return undefined;
	if (
		(n.node_type === "struct" || n.node_type === "enum") &&
		typeof n.name === "string" &&
		(n.name.startsWith("_Tuple_") || n.name.startsWith("_Anon_"))
	) {
		return undefined;
	}
	return n.namespace ?? n.scope?.namespace;
}

/**
 * Whether a declaration belongs to a built-in scalar type (`int`, `string`,
 * `bool`, ...): built-ins are language surface — their names work in every
 * namespace (literals coerce to them; string interpolation desugars to
 * `to_string` calls) — so namespace gates skip them. The declaring type is
 * the member's owner struct (`scope`); free functions have no owner here.
 */
export function decl_is_builtin_scoped(node: unknown): boolean {
	const n = node as { scope?: { name?: string } } | undefined;
	const owner = n?.scope as { name?: string } | undefined;
	return !!owner?.name && built_in_types.includes(owner.name);
}

/**
 * The accessor context for a visibility check (docs/SCOPING.md): the
 * namespace of the file whose code is doing the access, and that file's
 * granted namespaces. Resolution order:
 *
 * 1. the nearest stamped node on the scope stack below the root — a struct
 *    whose field defaults or method context is being checked;
 * 2. `current_function` — function bodies (and their signatures, checked
 *    before the body runs) never carry the function on the stack, so this
 *    is the accessor for everything inside a function;
 * 3. `current_scope_decl` — the struct/trait/enum/bitset whose members are
 *    being checked (field types, defaults, method signatures).
 *
 * Returns undefined when no accessor applies — compiler machinery resolving
 * types outside any code context (derive pre-passes, monomorphization
 * seeds). Those checks are never gated.
 */
export function accessor_context(
	status: import("../CheckStatus.ts").default,
): { ns: string; imports: Set<string> } | undefined {
	const empty = new Set<string>();
	const imports_of = (node: { file_id?: number } | undefined): Set<string> =>
		(node?.file_id !== undefined ? status.namespace_imports?.get(node.file_id) : undefined) ??
		empty;
	for (let i = status.stack.length - 1; i >= 0; i--) {
		const node = status.stack[i] as {
			node_type?: string;
			namespace?: string;
			file_id?: number;
		};
		// A root is a checking context, never an accessor: file-scope pragma
		// expansion pushes the (entry-namespace) root mid-stack, which would
		// otherwise shadow the enclosing library function's namespace.
		if (node.node_type === "root") continue;
		if (node.namespace !== undefined) {
			return { ns: node.namespace, imports: imports_of(node) };
		}
	}
	const cf = status.current_function;
	if (cf?.namespace !== undefined) {
		return { ns: cf.namespace, imports: imports_of(cf) };
	}
	const scope = status.current_scope_decl as { namespace?: string; file_id?: number } | undefined;
	if (scope?.namespace !== undefined) {
		return { ns: scope.namespace, imports: imports_of(scope) };
	}
	return undefined;
}
