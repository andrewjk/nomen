import add_error from "../add_error.ts";
import PragmaErrorNode from "../nodes/PragmaErrorNode.ts";
import parse_expression from "./parse_expression.ts";
import type ParseStatus from "./ParseStatus.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import get_index from "./utils/get_index.ts";

/**
 * `#error "message"` — the user-facing compile-error directive (the
 * Comptime II backlog's "comptime integers + arithmetic + a user `#error`"
 * item). The message is a single string literal — or an interpolated
 * comptime string (`"missing \{field.name}"`, parsed as an expression and
 * folded at CHECK time, src/check/check_node.ts) — so an `#error` inside a
 * dead `#if` arm never fires while a live one always fails the compile.
 */
export default function parse_pragma_error(status: ParseStatus): void {
	const start = get_index(status);
	consume(status); // #
	consume(status); // error

	const token = status.tokens[status.i];
	const value = token?.value ?? "";
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		consume(status); // the message literal
		const node = new PragmaErrorNode(start, value.substring(1, value.length - 1));
		add_to_parent(node, "Compile-time error", status);
		return;
	}
	// An interpolated message — `"missing \{field.name}"` tokenizes as
	// fragments + expression, so it parses as an expression here and folds
	// through the comptime string evaluator at check. Anything else
	// (a non-string token, a missing message) is the usage error.
	if (!token || !(value.startsWith('"') && !(value.length >= 2 && value.endsWith('"')))) {
		add_error(status, `#error takes a string literal — #error "message"`, get_index(status));
		return;
	}
	const node = new PragmaErrorNode(start, "");
	node.message_expr = parse_expression(status);
	add_to_parent(node, "Compile-time error", status);
}
