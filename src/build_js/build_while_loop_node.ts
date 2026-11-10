import type BaseNode from "../nodes/BaseNode.ts";
import type WhileLoopNode from "../nodes/WhileLoopNode.ts";
import { emit, expr, stmt } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/** Emit a while loop. The optional `; update` clause runs after each body
 *  iteration — including on `continue`, so it lowers to a `for (; cond;
 *  update)` loop rather than a `while` with the update appended to the body
 *  (JS `continue` would otherwise skip it and spin forever). */
export default function build_while_loop_node(node: WhileLoopNode, status: BuildStatus): void {
	const condition = expr(node.condition, status);
	if (node.update) {
		// The update must be emitted as an expression; Nomen updates are
		// assignments (`i += 1`), which render as `left op right`.
		const update = update_expression(node.update, status);
		emit(status, `for (; ${condition}; ${update}) {`);
	} else {
		emit(status, `while (${condition}) {`);
	}
	status.indent += 1;
	for (const statement of node.statements) stmt(statement, status);
	status.indent -= 1;
	emit(status, "}");
}

/** The `; update` clause as a JS expression (no trailing semicolon). */
export function update_expression(node: BaseNode | undefined, status: BuildStatus): string {
	if (!node) return "";
	if (node.node_type === "assign") {
		const assign = node as unknown as {
			left_value: Parameters<typeof expr>[0];
			right_value: Parameters<typeof expr>[0];
			operator?: string;
		};
		return `${expr(assign.left_value, status)} ${assign.operator ?? "="} ${expr(
			assign.right_value,
			status,
		)}`;
	}
	return expr(node, status);
}
