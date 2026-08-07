import type CheckStatus from "../CheckStatus.ts";

/**
 * True when the current checking position is inside a function body (a
 * FunctionNode is on the checking stack). Module-scope declarations (file
 * globals) are pushed with no enclosing function, so this distinguishes them
 * from function locals/params — the basis for `StackValue.is_global` and the
 * closure-capture rule in `check_value_node`.
 */
export default function in_function(status: CheckStatus): boolean {
	return status.stack.some((n) => n.node_type === "func");
}
