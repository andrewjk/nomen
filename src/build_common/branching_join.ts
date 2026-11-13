import type BuildStatus from "../build_c/BuildStatus.ts";
import type Type from "../nodes/Type.ts";

/**
 * Assignment-position branching RHS support (`x = match/switch/if …` —
 * `try/catch` desugars to a match). A branch expression lowers as a
 * statement whose arms assign a JOIN destination; the destination's type
 * decides the shape this module's consumers build:
 *
 * - 16 — a fat string join: the arms store an owned (ptr, len) pair (the
 *   join builds set `join_needs_owned_string` so literal/borrow branches
 *   strdup — the destination registers as a heap-string owner).
 * - 8 — a word join: scalars, simple enum tags, bitset masks, function
 *   values. A plain word store, no ownership.
 *
 * undefined — not covered: nullable slots (companion `_has` flags), views,
 * arrays, generics, value/class structs and traits (displaced-value
 * reclaim needs the dedicated reassignment paths), and enums with
 * associated data (a tag+payload construction, not a store of one value).
 * Those destinations keep the historical (broken) lowering rather than a
 * mis-sized or unsound one.
 */
export default function branching_join_size(
	type: Type | undefined,
	status: BuildStatus,
): number | undefined {
	if (!type?.name) return undefined;
	if (type.is_nullable || type.is_view || type.is_array || type.is_ref) return undefined;
	if (type.type_args?.length) return undefined;
	if (type.name === "string") return 16;
	if (status.enums.find((e) => e.name === type.name)?.has_associated_data) return undefined;
	if (status.structs.find((s) => s.name === type.name && !s.is_simple_type)) return undefined;
	if (status.traits.find((t) => t.name === type.name)) return undefined;
	return 8;
}

/** Whether the node is one of the branch-expression forms a join lowers. */
export function is_branch_expression(node: { node_type: string }): boolean {
	return node.node_type === "match" || node.node_type === "switch" || node.node_type === "if";
}
