import type BuildStatus from "../build_c/BuildStatus.ts";
import type EnumNode from "../nodes/EnumNode.ts";

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
