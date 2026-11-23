import { ns_is_ancestor_or_self } from "./namespaces.ts";

/**
 * Check if an item is visible from the current access scope
 * (docs/SCOPING.md). Visibility tracks NAMESPACES:
 *
 * - `pub` — reachable wherever the namespace is reachable: the accessor's
 *   own namespace, an ancestor of it (parent namespaces are accessible
 *   without an import), or a namespace the accessor's file imports.
 * - `internal` — additionally only within the declaring namespace and its
 *   DESCENDANTS: a child namespace sees its parents' internals
 *   (`System::Controls` calling `Buffer`'s slab accessors), but a sibling
 *   or an outside consumer does not, even when the namespace is imported.
 * - unmarked (spelled `"private"` — the retired keyword survives only as
 *   this visibility value) — the declaring namespace ONLY: the tightest
 *   scope. Not even ancestors see it.
 *
 * Declarations without a stamped namespace (inline parses with no
 * `// file://` markers) all share the empty namespace and stay visible to
 * each other, preserving pre-scoping behavior for tests and tooling.
 */
export default function is_visible(
	declaring_namespace: string | undefined,
	visibility: "pub" | "private" | "internal",
	accessor_namespace: string | undefined,
	accessor_imports?: Set<string>,
): boolean {
	if (declaring_namespace === undefined || accessor_namespace === undefined) return true;
	if (visibility === "private") {
		// Unmarked: own namespace, nothing else.
		return declaring_namespace === accessor_namespace;
	}
	if (visibility === "internal") {
		// Declaring namespace and its descendants only — imports don't help.
		return ns_is_ancestor_or_self(declaring_namespace, accessor_namespace);
	}
	// pub: the namespace reachability gate.
	return (
		ns_is_ancestor_or_self(declaring_namespace, accessor_namespace) ||
		(accessor_imports?.has(declaring_namespace) ?? false)
	);
}
