import add_error from "../add_error.ts";
import PragmaErrorNode from "../nodes/PragmaErrorNode.ts";
import type ParseStatus from "./ParseStatus.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import get_index from "./utils/get_index.ts";

/**
 * `#error "message"` — the user-facing compile-error directive (the
 * Comptime II backlog's "comptime integers + arithmetic + a user `#error`"
 * item). The message is a single string literal; the node reports it at
 * CHECK time (src/check/check_node.ts), so an `#error` inside a dead `#if`
 * arm never fires while a live one always fails the compile.
 */
export default function parse_pragma_error(status: ParseStatus): void {
	const start = get_index(status);
	consume(status); // #
	consume(status); // error

	const token = status.tokens[status.i];
	const value = token?.value ?? "";
	if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
		add_error(status, `#error takes a string literal — #error "message"`, get_index(status));
		return;
	}
	consume(status); // the message literal

	const node = new PragmaErrorNode(start, value.substring(1, value.length - 1));
	add_to_parent(node, "Compile-time error", status);
}
