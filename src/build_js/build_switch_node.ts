import type SwitchNode from "../nodes/SwitchNode.ts";
import { branch_body, capture_expression, emit, expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/** `switch` as a statement: an if/else-if chain over boolean case
 *  expressions (Nomen switch cases are conditions, not values). */
export function build_switch_statement(node: SwitchNode, status: BuildStatus): void {
	emit_switch(node, status, false);
}

/** `switch` in expression position: an IIFE whose branches return. */
export function build_switch_expression(node: SwitchNode, status: BuildStatus): string {
	return capture_expression(status, () => emit_switch(node, status, true));
}

function emit_switch(node: SwitchNode, status: BuildStatus, value_mode: boolean): void {
	if (node.cases.length === 0) {
		if (value_mode) {
			emit(status, `return __unsupported("empty switch");`);
		}
		return;
	}

	node.cases.forEach((switch_case, index) => {
		emit(status, `${index === 0 ? "if" : "else if"} (${expr(switch_case.condition, status)}) {`);
		status.indent += 1;
		branch_body(switch_case.branch.statements ?? [], status, value_mode);
		status.indent -= 1;
		emit(status, "}");
	});

	if (node.else_branch) {
		emit(status, "else {");
		status.indent += 1;
		branch_body(node.else_branch.statements ?? [], status, value_mode);
		status.indent -= 1;
		emit(status, "}");
	} else if (value_mode) {
		emit(status, "else {");
		status.indent += 1;
		emit(status, `return __unsupported("switch: no matching case");`);
		status.indent -= 1;
		emit(status, "}");
	}
}
