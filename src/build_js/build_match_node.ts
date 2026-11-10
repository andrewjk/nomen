import type MatchNode from "../nodes/MatchNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import {
	branch_body,
	capture_expression,
	emit,
	emit_referenced_allocations,
	expr,
	next_temp,
} from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { find_enum_case } from "./enums.ts";
import { js_name } from "./names.ts";

/** `match` as a statement: an if/else chain over a hoisted scrutinee. Enum
 *  cases test the tag and bind the payload positionally. */
export function build_match_statement(node: MatchNode, status: BuildStatus): void {
	emit_match(node, status, false);
}

/** `match` in expression position: an IIFE whose branches return. */
export function build_match_expression(node: MatchNode, status: BuildStatus): string {
	return capture_expression(status, () => emit_match(node, status, true));
}

function emit_match(node: MatchNode, status: BuildStatus, value_mode: boolean): void {
	const temp = next_temp(status, "match");
	emit(status, "{");
	status.indent += 1;
	const scrutinee = expr(node.value, status);
	emit_referenced_allocations(status, node, scrutinee);
	emit(status, `const ${temp} = ${scrutinee};`);

	node.cases.forEach((match_case, index) => {
		const enum_hit =
			match_case.match_value.node_type === "value"
				? find_enum_case(status.enums, (match_case.match_value as ValueNode).value)
				: undefined;
		const condition = enum_hit
			? `${temp}.$tag === ${enum_hit.case_index}`
			: `${temp} === ${expr(match_case.match_value, status)}`;
		emit(status, `${index === 0 ? "if" : "else if"} (${condition}) {`);
		status.indent += 1;
		if (enum_hit) {
			const case_def = enum_hit.enum_node.cases[enum_hit.case_index];
			(match_case.params ?? []).forEach((param, i) => {
				const field = case_def.params[i]?.name ?? `$${i}`;
				emit(status, `const ${js_name(param)} = ${temp}.${field};`);
			});
		}
		branch_body(match_case.branch.statements ?? [], status, value_mode);
		status.indent -= 1;
		emit(status, "}");
	});

	emit(status, "else {");
	status.indent += 1;
	if (node.else_branch) {
		branch_body(node.else_branch.statements ?? [], status, value_mode);
	} else if (value_mode) {
		emit(status, `return __unsupported("match: no matching case");`);
	} else {
		emit(status, `__panic("no matching match case");`);
	}
	status.indent -= 1;
	emit(status, "}");

	status.indent -= 1;
	emit(status, "}");
}
