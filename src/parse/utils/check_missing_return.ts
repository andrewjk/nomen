import add_error from "../../add_error.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import type ParseStatus from "../ParseStatus.ts";

/**
 * A block body with a declared return type must contain at least one
 * `return` (a body consisting only of raw `#arch:` blocks is exempt —
 * it returns through the backend, not Nomen `return`). Shared by named
 * functions and block-bodied anonymous functions; call it right after the
 * closing brace is consumed. `#init`/`#destroy` are exempt only because
 * the named-function call site gates them, not here.
 */
export default function check_missing_return(func: FunctionNode, status: ParseStatus): void {
	if (!func.return_type.name || func.has_return) {
		return;
	}
	const is_raw_only =
		func.statements.length > 0 && func.statements.every((s) => s.node_type === "raw");
	if (is_raw_only) {
		return;
	}
	add_error(status, `Missing return`, status.tokens[status.i - 2].i);
}
