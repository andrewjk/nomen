import type ParseStatus from "../ParseStatus.ts";
import accept from "./accept.ts";
import consume from "./consume.ts";

export interface QualifiedName {
	/** Every segment of the path, e.g. `["System", "Controls", "Button"]`. */
	segments: string[];
	/** The final segment — namespaces flatten away in the AST. */
	base: string;
}

/**
 * Consume a possibly namespace-qualified name (`Controls::Button`) after its
 * first segment has already been consumed. Qualified references resolve by
 * bare name (the compilation unit is flat), so callers keep only `base`; the
 * full segment list is recorded on `status.qualified_paths` so `parse` can
 * validate the namespace prefixes against the library index. Import paths
 * pass `record = false` — imports may name files (e.g. `Utils::Widget`) as
 * well as library namespaces, so they are not prefix-validated.
 */
export default function parse_qualified_name(
	status: ParseStatus,
	first: string,
	start: number,
	record = true,
): QualifiedName {
	const segments = [first];
	while (accept("::", status)) {
		segments.push(consume(status));
	}
	if (record && segments.length > 1) {
		status.qualified_paths.push({ segments, start });
	}
	return { segments, base: segments[segments.length - 1] };
}
