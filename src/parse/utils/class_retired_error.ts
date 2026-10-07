import add_error from "../../add_error.ts";
import type ParseStatus from "../ParseStatus.ts";
import consume from "./consume.ts";
import get_index from "./get_index.ts";

/**
 * STRUCT_PLAN_3 Phase R: the `class` keyword has retired. Emits the
 * retirement error at the current token (which must be `class`) and
 * consumes it; the caller continues parsing the declaration as an
 * `owning struct` — the class-era object model (single-owner, move-only)
 * — so the user sees one clear error per declaration, no cascade.
 */
export default function class_retired_error(status: ParseStatus) {
	add_error(
		status,
		`'class' has retired — declare \`owning struct\` (single-owner, move-only) and spell sharing where it happens (\`ref\`, \`Box<T>\`, \`Mutex<T>\`, \`WeakHandle<T>\`)`,
		get_index(status),
	);
	consume(status);
}
