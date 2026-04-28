import type BuildStatus from "../BuildStatus.ts";

/**
 * Clones a status for passing down to building in a block and discarding afterwards
 */
export default function clone_status(status: BuildStatus): BuildStatus {
	return {
		root: status.root,
		structs: status.structs,
		traits: status.traits,
		headers: status.headers,
		code: status.code,
		// Empty scoped declarations, so that we are only dealing with the
		// declarations from the current scope
		scoped_declarations: [],
		return_assign: status.return_assign,
		interpolate_string_counts: new Set(),
	};
}
