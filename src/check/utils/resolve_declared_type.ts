import type FunctionNode from "../../nodes/FunctionNode.ts";
import type CheckStatus from "../CheckStatus.ts";

/** A declared type node whose emission name may have been scope-labelled. */
export interface DeclaredTypeNode {
	name: string;
	source_name?: string;
	/** Emission label of the function whose body declares this type. */
	emission_scope?: string;
}

/**
 * Whether a declaration is visible from the checker's current scope. A
 * top-level declaration (no emission scope) is always visible; a nested one
 * only while its declaring function is on the scope stack. Without this, a
 * scope-labelled nested type (`f_Box`) would be found by name from a sibling
 * function and shadow the top-level type it collides with.
 */
function is_visible(node: DeclaredTypeNode, status: CheckStatus): boolean {
	if (!node.emission_scope) return true;
	for (const n of status.stack) {
		if (n.node_type !== "func") continue;
		const fn = n as FunctionNode;
		if ((fn.label_name ?? fn.name) === node.emission_scope) return true;
	}
	return false;
}

function resolve_in(
	name: string,
	arr: readonly DeclaredTypeNode[] | undefined,
	status: CheckStatus,
): DeclaredTypeNode | undefined {
	if (!arr) return undefined;
	// Source name first (so a scope-labelled nested declaration is preferred
	// over an unrelated same-named root one), then the emission name.
	const visible = arr.filter((n) => is_visible(n, status));
	return (
		visible.findLast((n) => n.source_name === name) ?? visible.findLast((n) => n.name === name)
	);
}

/**
 * Resolve a source-level type name to its declaration, honouring scope. A
 * nested declaration whose source name collides with another type in the
 * program carries a scope-unique `name` plus the original `source_name`.
 * Returns undefined when no visible declaration matches — typically a
 * primitive/builtin name, which the caller validates against `status.types`.
 */
export default function resolve_declared_type(
	name: string,
	status: CheckStatus,
): DeclaredTypeNode | undefined {
	return (
		resolve_in(name, status.structs as readonly DeclaredTypeNode[], status) ??
		resolve_in(name, status.enums as readonly DeclaredTypeNode[], status) ??
		resolve_in(name, status.bitsets as readonly DeclaredTypeNode[], status) ??
		resolve_in(name, status.traits as readonly DeclaredTypeNode[], status)
	);
}

/** Struct-specific variant of {@link resolve_declared_type} for constructors. */
export function resolve_declared_struct(
	name: string,
	status: CheckStatus,
): DeclaredTypeNode | undefined {
	return resolve_in(name, status.structs as readonly DeclaredTypeNode[], status);
}
