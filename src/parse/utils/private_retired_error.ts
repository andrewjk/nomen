import add_error from "../../add_error.ts";
import type ParseStatus from "../ParseStatus.ts";
import get_index from "./get_index.ts";

/**
 * The `private` keyword has retired: an unmarked declaration is already the
 * tightest scope (file-scoped at the top level, exported member defaults
 * unchanged), so `private` named a default nobody had to write. Emits the
 * retirement error at the current token and leaves consumption to the
 * caller's normal visibility path — the declaration continues as if the
 * keyword were absent, so the user sees one clear error per declaration and
 * no cascade.
 */
export default function private_retired_error(status: ParseStatus, start = get_index(status)) {
	add_error(
		status,
		"'private' has retired — an unmarked declaration is already the tightest scope: drop the keyword, or spell `internal` (this library) or `pub` (everywhere)",
		start,
	);
}
