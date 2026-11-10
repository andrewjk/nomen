import type ForLoopNode from "../nodes/ForLoopNode.ts";
import type RangeNode from "../nodes/RangeNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import { emit, expr, stmt } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { js_name } from "./names.ts";

/** Emit a `for` loop over a range (`for i of 0 .. n`) or an array
 *  (`for x of xs`, optionally with an index: `for i, x of xs`). */
export default function build_for_loop_node(node: ForLoopNode, status: BuildStatus): void {
	const item_name = js_name((node.item as ValueNode).value);

	if (node.list.node_type === "range") {
		const range = node.list as RangeNode;
		// Bounds are evaluated once (the C backend hoists them too).
		emit(
			status,
			`for (let ${item_name} = ${expr(range.left_value, status)}, __end = ${expr(
				range.right_value,
				status,
			)}; ${item_name} < __end; ${item_name} = ${item_name} + 1n) {`,
		);
		status.indent += 1;
		for (const statement of node.statements) stmt(statement, status);
		status.indent -= 1;
		emit(status, "}");
		return;
	}

	const list = expr(node.list, status);
	if (node.index) {
		const index_name = js_name((node.index as ValueNode).value);
		emit(
			status,
			`for (let ${index_name} = 0n; ${index_name} < BigInt(${list}.length); ${index_name} = ${index_name} + 1n) {`,
		);
		status.indent += 1;
		emit(status, `const ${item_name} = ${list}[Number(${index_name})];`);
		for (const statement of node.statements) stmt(statement, status);
		status.indent -= 1;
		emit(status, "}");
		return;
	}

	emit(status, `for (const ${item_name} of ${list}) {`);
	status.indent += 1;
	for (const statement of node.statements) stmt(statement, status);
	status.indent -= 1;
	emit(status, "}");
}
