import add_error from "../../add_error.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import type CheckStatus from "../CheckStatus.ts";

/**
 * The parse-time `Missing return` check (parse/utils/check_missing_return.ts)
 * only sees a lambda's OWN `out T` param. A lambda whose return type comes
 * from the TARGET signature — a declaration annotation, a func-typed
 * parameter, or a func-typed field — has an empty `return_type` at parse
 * time, so the checker's signature merge is the first place the declared
 * return type is known. Call this right after a merge fills
 * `func.return_type`: a BLOCK body with a non-empty return type must
 * contain at least one `return` (arrow bodies always return their
 * expression; a body of only raw `#arch:` blocks returns through the
 * backend — both exempt, matching the parse-time net).
 */
export default function check_merged_missing_return(func: FunctionNode, status: CheckStatus): void {
	if (!func.return_type.name || func.has_return || func.is_arrow_body || !func.has_body) {
		return;
	}
	const is_raw_only =
		func.statements.length > 0 && func.statements.every((s) => s.node_type === "raw");
	if (is_raw_only) {
		return;
	}
	add_error(status, `Missing return`, func.start);
}
