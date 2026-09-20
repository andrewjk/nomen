import type AssignmentNode from "../../nodes/AssignmentNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import type LetNode from "../../nodes/LetNode.ts";
import type BuildStatus from "../BuildStatus.ts";

/**
 * Whether a STATEMENT's emitted C ends with a closing brace (`}\n`), so the
 * statement tail must NOT append a terminating `;\n` after it.
 *
 * `status.code.endsWith("}\n")` answers this directly, but forces V8 to
 * flatten the accumulated code rope — an O(code) copy at per-statement
 * frequency, which made builds quadratic in memory. This classification is
 * the node-driven replacement (corpus-verified over the full test suite):
 *
 * - `assign`: a swap assignment marshals through a trailing `{ …; }` block;
 *   a string FIELD store lowers to a braced block that self-reports via
 *   `status.c_stmt_ends_block` (the shape alone can't decide — a scalar
 *   field store with the same AST ends with `;\n`).
 * - `declare` / `let`: an `if`/`match`/`switch` VALUE is lowered to a block
 *   statement (the join's last arm closes `}\n` and nothing follows).
 * - everything else (`return` ends `return …;\n` even for branch values —
 *   the join value builds blocks then returns the join variable; calls,
 *   accesses, operators, breaks/continues end with a value, `)`, or `;\n`).
 *
 * The `c_stmt_ends_block` self-report is consumed on read (reset to false)
 * so a flagged store can never leak into a later statement's tail.
 */
export function statement_ends_with_block(
	node: BaseNode | undefined,
	status: BuildStatus,
): boolean {
	const flagged = status.c_stmt_ends_block === true;
	status.c_stmt_ends_block = false;
	if (flagged) return true;
	if (!node) return false;
	switch (node.node_type) {
		case "assign":
			return !!(node as AssignmentNode).swap;
		case "declare": {
			const init = (node as DeclarationNode).value;
			return (
				!!init &&
				(init.node_type === "if" || init.node_type === "match" || init.node_type === "switch")
			);
		}
		case "let": {
			const value = (node as LetNode).value;
			return (
				value.node_type === "if" || value.node_type === "match" || value.node_type === "switch"
			);
		}
		default:
			return false;
	}
}
