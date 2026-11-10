import type ForLoopNode from "../nodes/ForLoopNode.ts";
import type RangeNode from "../nodes/RangeNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import { emit, expr, next_temp, stmt } from "./build_node.ts";
import { update_expression } from "./build_while_loop_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { js_name } from "./names.ts";

/** Emit a `for` loop over a range (`for i of 0 .. n`) or an array
 *  (`for x of xs`, optionally with an index: `for i, x of xs`). A `; update`
 *  clause runs at the end of each iteration (matching the native backends). */
export default function build_for_loop_node(node: ForLoopNode, status: BuildStatus): void {
	const item_name = js_name((node.item as ValueNode).value);
	const update = node.update ? update_expression(node.update, status) : undefined;

	if (node.list.node_type === "range") {
		const range = node.list as RangeNode;
		// Bounds are evaluated once (the C backend hoists them too).
		const increment = `${item_name} = ${item_name} + 1n`;
		emit(
			status,
			`for (let ${item_name} = ${expr(range.left_value, status)}, __end = ${expr(
				range.right_value,
				status,
			)}; ${item_name} < __end; ${increment}) {`,
		);
		status.indent += 1;
		for (const statement of node.statements) stmt(statement, status);
		if (update) emit(status, `${update};`);
		status.indent -= 1;
		emit(status, "}");
		return;
	}

	const list = expr(node.list, status);

	// `for ref x of xs`: mutations to `x` (or its fields) must reach the
	// element. A JS `for…of` binds a local, so iterate by index and write the
	// binding back in a `finally` (which also runs on break/continue/return).
	if (node.item_is_ref) {
		const array = next_temp(status, "arr");
		const index = next_temp(status, "idx");
		const increment = `${index} = ${index} + 1n`;
		emit(status, "{");
		status.indent += 1;
		emit(status, `const ${array} = ${list};`);
		emit(status, `for (let ${index} = 0n; ${index} < BigInt(${array}.length); ${increment}) {`);
		status.indent += 1;
		emit(status, `let ${item_name} = ${array}[Number(${index})];`);
		emit(status, "try {");
		status.indent += 1;
		for (const statement of node.statements) stmt(statement, status);
		if (update) emit(status, `${update};`);
		status.indent -= 1;
		emit(status, "} finally {");
		status.indent += 1;
		emit(status, `${array}[Number(${index})] = ${item_name};`);
		status.indent -= 1;
		emit(status, "}");
		status.indent -= 1;
		emit(status, "}");
		status.indent -= 1;
		emit(status, "}");
		return;
	}

	if (node.index) {
		const index_name = js_name((node.index as ValueNode).value);
		emit(
			status,
			`for (let ${index_name} = 0n; ${index_name} < BigInt(${list}.length); ${index_name} = ${index_name} + 1n) {`,
		);
		status.indent += 1;
		emit(status, `const ${item_name} = ${list}[Number(${index_name})];`);
		for (const statement of node.statements) stmt(statement, status);
		if (update) emit(status, `${update};`);
		status.indent -= 1;
		emit(status, "}");
		return;
	}

	emit(status, `for (const ${item_name} of ${list}) {`);
	status.indent += 1;
	for (const statement of node.statements) stmt(statement, status);
	if (update) emit(status, `${update};`);
	status.indent -= 1;
	emit(status, "}");
}
