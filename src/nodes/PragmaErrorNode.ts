import BaseNode from "./BaseNode.ts";

/**
 * A user compile-error directive — `#error "message"` (the Comptime II
 * backlog's "comptime integers + a user `#error`" item). Parsed anywhere a
 * statement is legal; never checked past the report and never built: the
 * statement walk reports the message as a compile error when it reaches the
 * node.
 *
 * Because the `#if` fold (stage 1) runs BEFORE any checking and drops dead
 * arms, an `#error` inside an arm that folded away never fires — the
 * standard target-gating shape:
 *
 * ```
 * #if META.arch == "js" {
 *     #error "this module needs a native target"
 * }
 * ```
 *
 * A live `#error` always fails the compile, so no backend ever sees the
 * node (the backends' strict unknown-node contract would throw).
 */
export default class PragmaErrorNode extends BaseNode {
	message: string;

	constructor(start: number, message: string) {
		super("pragma_error", start);
		this.message = message;
	}
}
