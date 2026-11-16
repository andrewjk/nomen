import add_error from "../add_error.ts";
import NestedBlockNode from "../nodes/NestedBlockNode.ts";
import PragmaIfNode from "../nodes/PragmaIfNode.ts";
import parse_expression from "./parse_expression.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

/**
 * `#if <condition> { ... }` with optional `#elif` / `#else` arms — the
 * compile-time conditional (docs/COMPTIME_PLAN_2.md stage 1).
 *
 * Parsed wherever a statement or declaration is legal (parse_statement's
 * single loop serves both), and the arms are ordinary blocks — funcs,
 * structs, statements and raw code inside them parse identically to code
 * outside. The CONDITION grammar is not validated here: parsing reuses the
 * ordinary expression parser (so `META.arch == "c"` builds the same
 * OperationNode/ValueNode shapes an `if` condition would), and
 * evaluate_pragma_condition rejects anything outside the tiny comptime
 * grammar when the checker folds the pragma.
 */
export default function parse_pragma_if(status: ParseStatus): PragmaIfNode {
	const start = get_index(status);
	consume(status); // #
	consume(status); // if
	const pragma = new PragmaIfNode(start);
	status.stack.push(pragma);

	// `#if <condition> { ... }`
	pragma.branches.push({
		condition: parse_expression(status),
		block: parse_pragma_block(status, pragma),
	});

	// `#elif <condition> { ... }` — any number, before an optional `#else`.
	// Like `#if` itself, the tags tokenize as `#` + word, so both tokens
	// are consumed per arm.
	while (peek_current(status) === "#" && status.tokens[status.i + 1]?.value === "elif") {
		consume(status); // #
		consume(status); // elif
		pragma.branches.push({
			condition: parse_expression(status),
			block: parse_pragma_block(status, pragma),
		});
	}

	// `#else { ... }` — optional, always last. An `#elif` after it is an
	// error, but the arm still parses (reaching the fold as unreachable) so
	// the single error doesn't cascade through the statement loop.
	if (peek_current(status) === "#" && status.tokens[status.i + 1]?.value === "else") {
		consume(status); // #
		consume(status); // else
		pragma.branches.push({ condition: null, block: parse_pragma_block(status, pragma) });
		if (peek_current(status) === "#" && status.tokens[status.i + 1]?.value === "elif") {
			add_error(status, "Expected { after #else — #elif cannot follow #else", get_index(status));
			consume(status); // #
			consume(status); // elif
			pragma.branches.push({
				condition: parse_expression(status),
				block: parse_pragma_block(status, pragma),
			});
		}
	}

	status.stack.pop();
	return pragma;
}

/**
 * Parse one `{ ... }` arm. The PRAGMA stays on the stack as the attach
 * parent (so declarations inside the arm are legal wherever the pragma
 * itself is — file scope, function body, nested block) and its
 * `statements` collector gathers the arm's contents; on `}` the collector
 * moves into a plain block holder that the checker's fold splices from.
 */
function parse_pragma_block(status: ParseStatus, pragma: PragmaIfNode): NestedBlockNode {
	const block_start = get_index(status);
	expect("{", status);
	pragma.statements = [];
	parse_statement(status);
	expect("}", status);
	const block = new NestedBlockNode(block_start, pragma.statements);
	pragma.statements = [];
	return block;
}
