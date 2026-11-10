import type IfElseNode from "../nodes/IfElseNode.ts";
import {
	branch_body,
	capture_expression,
	emit,
	emit_referenced_allocations,
	expr,
	stmt,
} from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/** Emit an if/else statement. (Expression-position `if` is not in the v1
 *  subset; using one as a value hits `__unsupported`.) */
export default function build_if_else_node(node: IfElseNode, status: BuildStatus): void {
	emit(status, `if (${expr(node.condition, status)}) {`);
	status.indent += 1;
	for (const statement of node.if_branch?.statements ?? []) stmt(statement, status);
	status.indent -= 1;
	if (node.else_branch) {
		emit(status, "} else {");
		status.indent += 1;
		for (const statement of node.else_branch.statements ?? []) stmt(statement, status);
		status.indent -= 1;
	}
	emit(status, "}");
}

/** `if` in expression position (`const label = if c -> a else -> b`): an
 *  IIFE whose branches return their value. */
export function build_if_expression(node: IfElseNode, status: BuildStatus): string {
	return capture_expression(status, () => {
		const condition = expr(node.condition, status);
		emit_referenced_allocations(status, node, condition);
		emit(status, `if (${condition}) {`);
		status.indent += 1;
		branch_body(node.if_branch?.statements ?? [], status, true);
		status.indent -= 1;
		if (node.else_branch) {
			emit(status, "} else {");
			status.indent += 1;
			branch_body(node.else_branch.statements, status, true);
			status.indent -= 1;
		}
		emit(status, "}");
	});
}
