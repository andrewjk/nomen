import type BuildStatus from "../build_c/BuildStatus.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type Type from "../nodes/Type.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import { mono_type_name } from "./mono_name.ts";
import { collect_expression_branch_values } from "./string_return_analysis.ts";

export interface BranchingJoin {
	/**
	 * "string" — a fat (ptr, len) pair join (arms strdup non-owned values).
	 * "word" — a scalar / simple-enum-tag / bitset / function-value join,
	 * and a Box<T>-wrapper local (the stamped heap-handle storage shape):
	 * the arms produce handles and the join is a word store.
	 * "struct" — an inline value struct (plain or `mv`) or an enum with
	 * associated data: the arms produce the value's ADDRESS and the join
	 * is a byte copy.
	 */
	kind: "string" | "word" | "struct";
	/** The monomized struct/enum name (struct kind), for spelling temps. */
	mono_name: string;
	/** struct kind only: the type is an enum with associated data. */
	is_enum_data?: boolean;
}

/**
 * Assignment-position (and declaration-position on aarch64) branching RHS
 * support (`x = match/switch/if …` — `try/catch` desugars to a match). A
 * branch expression lowers as a statement whose arms assign a JOIN
 * destination; the destination's type decides the shape the backends build.
 *
 * undefined — not covered: nullable slots (companion `_has` flags — a
 * mixed null/scalar arm set is rejected by the checker, but a nullable-
 * typed arm set would need per-arm flag joins), views, arrays, `ref`
 * slots, and traits (a trait-typed join needs the return path's
 * concrete-branch boxing at the join point).
 */
export default function branching_join(
	type: Type | undefined,
	status: BuildStatus,
): BranchingJoin | undefined {
	if (!type?.name) return undefined;
	if (type.is_nullable || type.is_view || type.is_array || type.is_ref) return undefined;
	if (type.name === "string") return { kind: "string", mono_name: "string" };
	// Monomized name first (`List<int>` → `List_int`): the struct table only
	// carries the mono, a bare-name find would miss every container local.
	const mono = type.type_args?.length ? mono_type_name(type) : type.name;
	const data_enum = status.enums.find((e) => e.name === mono && e.has_associated_data);
	if (data_enum) {
		return { kind: "struct", mono_name: mono, is_enum_data: true };
	}
	const struct = status.structs.find((s) => s.name === mono && !s.is_simple_type);
	if (struct) {
		// Box<T> wrappers are the heap-HANDLE representation (the stamped
		// `is_class` storage shape): a local holds a pointer, the arms
		// produce handles, the join is a word store. Every other struct —
		// including user `mv struct` values — is an inline blob: the arms
		// produce the value's ADDRESS and the join is a struct copy.
		if (struct.is_class) return { kind: "word", mono_name: mono };
		return { kind: "struct", mono_name: mono };
	}
	if (status.traits.find((t) => t.name === mono)) return undefined;
	return { kind: "word", mono_name: mono };
}

/** Whether the node is one of the branch-expression forms a join lowers. */
export function is_branch_expression(node: { node_type: string }): boolean {
	return node.node_type === "match" || node.node_type === "switch" || node.node_type === "if";
}

/**
 * Whether every branch value of a branching expression is statically
 * non-null (no `null` literal, no nullable-typed expression). The checker
 * rejects a mixed null/scalar arm set, so a nullable-slot join is either
 * uniformly non-null (the flag joins as 1) or uniformly nullable-typed
 * (per-arm flag joins — unsupported, returns false).
 */
export function branch_values_all_non_null(
	node: BaseNode,
	type_from_value_node: (node: BaseNode) => Type | undefined,
): boolean {
	const values = collect_expression_branch_values(node) as BaseNode[];
	if (!values.length) return false;
	for (const v of values) {
		if (v.node_type === "value" && (v as ValueNode).value === "null") return false;
		if (type_from_value_node(v)?.is_nullable) return false;
	}
	return true;
}
