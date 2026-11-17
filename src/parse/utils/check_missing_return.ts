import add_error from "../../add_error.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import type ParseStatus from "../ParseStatus.ts";

/**
 * A block body with a declared return type must contain at least one
 * `return` (a body consisting only of `#raw` blocks is exempt —
 * it returns through the backend, not Nomen `return`; a body consisting
 * only of `#if`-wrapped raw blocks is the same shape — stage 5 wraps each
 * fence in a pragma arm). Shared by named functions and block-bodied
 * anonymous functions; call it right after the closing brace is consumed.
 * `#init`/`#destroy` are exempt only because the named-function call site
 * gates them, not here.
 */
export default function check_missing_return(func: FunctionNode, status: ParseStatus): void {
	if (!func.return_type.name || func.has_return) {
		return;
	}
	// ERRORS_PLAN: a unit-result function (`out ! E`) falls through as
	// SUCCESS — no explicit return is required.
	if (func.unit_result) {
		return;
	}
	const statements = func.statements;
	const is_raw_only =
		statements.length > 0 &&
		statements.every(
			(s) =>
				s.node_type === "raw" ||
				// `#if`-wrapped raw blocks: every arm is raw-only (stage 5).
				(s.node_type === "pragma_if" &&
					(s as import("../../nodes/PragmaIfNode.ts").default).branches.every((b) =>
						(b.block.statements ?? []).every((inner) => inner.node_type === "raw"),
					)),
		);
	if (is_raw_only) {
		return;
	}
	add_error(status, `Missing return`, status.tokens[status.i - 2].i);
}
