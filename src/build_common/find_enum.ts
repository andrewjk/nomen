import type BuildStatus from "../build_c/BuildStatus.ts";
import type EnumNode from "../nodes/EnumNode.ts";

/**
 * Resolve a checker-rewritten enum case value (`Enum_case`, e.g.
 * `Result_int_string_ok`) to the enum that actually declares the case.
 * Iterating instead of taking the first prefix match matters for generic
 * enums: the value of a monomorphized case (`Option_int_none`) prefix-matches
 * the bare generic (`Option_`) whose case set does NOT contain
 * `int_none` — only the mono (`Option_int`) has the case. Case-existence is
 * the disambiguator, so the longest-name match always wins naturally.
 */
export function find_enum_for_case(
	value: string,
	status: BuildStatus,
): { enum_node: EnumNode; case_name: string } | undefined {
	for (const e of status.enums) {
		if (!value.startsWith(e.name + "_")) continue;
		const case_name = value.substring(e.name.length + 1);
		if (e.cases.some((c: { name: string }) => c.name === case_name)) {
			return { enum_node: e, case_name };
		}
	}
	return undefined;
}

/**
 * Find an enum by either its emission `name` (the normal case, already
 * rewritten by the checker) or its `source_name` — a nested enum whose source
 * name collides with another type in the program is emitted under a
 * scope-unique label, but build paths that reach it through a raw source
 * identifier (e.g. the `Color` in `Color.green`) still carry the source name.
 */
export default function find_enum(
	name: string | undefined,
	status: BuildStatus,
): EnumNode | undefined {
	if (!name) return undefined;
	return (
		status.enums.find((e) => e.name === name) ?? status.enums.find((e) => e.source_name === name)
	);
}
