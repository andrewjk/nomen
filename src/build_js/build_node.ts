import type AccessNode from "../nodes/AccessNode.ts";
import type ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import type AssignmentNode from "../nodes/AssignmentNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type CastNode from "../nodes/CastNode.ts";
import type DeclarationNode from "../nodes/DeclarationNode.ts";
import type ForLoopNode from "../nodes/ForLoopNode.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type GroupedNode from "../nodes/GroupedNode.ts";
import type IfElseNode from "../nodes/IfElseNode.ts";
import type OperationNode from "../nodes/OperationNode.ts";
import type PanicNode from "../nodes/PanicNode.ts";
import type ReturnNode from "../nodes/ReturnNode.ts";
import type StructNode from "../nodes/StructNode.ts";
import type TodoNode from "../nodes/TodoNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import type WhileLoopNode from "../nodes/WhileLoopNode.ts";
import build_access_node from "./build_access_node.ts";
import build_array_values_node from "./build_array_values_node.ts";
import build_assignment_node from "./build_assignment_node.ts";
import build_break_node from "./build_break_node.ts";
import build_cast_node from "./build_cast_node.ts";
import build_continue_node from "./build_continue_node.ts";
import build_declaration_node from "./build_declaration_node.ts";
import build_for_loop_node from "./build_for_loop_node.ts";
import build_function_call_node from "./build_function_call_node.ts";
import build_function_node, { build_function_expression } from "./build_function_node.ts";
import build_grouped_node from "./build_grouped_node.ts";
import { build_if_expression } from "./build_if_else_node.ts";
import build_if_else_node from "./build_if_else_node.ts";
import { build_match_expression } from "./build_match_node.ts";
import { build_match_statement } from "./build_match_node.ts";
import build_operation_node from "./build_operation_node.ts";
import build_panic_node from "./build_panic_node.ts";
import build_return_node from "./build_return_node.ts";
import build_struct_node from "./build_struct_node.ts";
import { build_switch_expression } from "./build_switch_node.ts";
import { build_switch_statement } from "./build_switch_node.ts";
import build_todo_node from "./build_todo_node.ts";
import build_value_node from "./build_value_node.ts";
import build_while_loop_node from "./build_while_loop_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/** Append a statement line at the current indentation. */
export function emit(status: BuildStatus, text: string): void {
	status.code += "\t".repeat(status.indent) + text + "\n";
}

/** A fresh generated temp name (`__match_0`, `__switch_1`, …). */
export function next_temp(status: BuildStatus, prefix: string): string {
	const name = `__${prefix}_${status.temp}`;
	status.temp += 1;
	return name;
}

/**
 * Emit an expression-position construct (if/switch/match used as a value) as
 * an IIFE. The builder emits statements into a scratch buffer at one extra
 * indent level; the wrapper becomes a single JS expression.
 */
export function capture_expression(status: BuildStatus, build: () => void): string {
	const body = capture_body(status, build);
	return `(() => {\n${body}${"\t".repeat(status.indent)}})()`;
}

/** Emit statements into a scratch buffer at one extra indent level and return
 *  the text (used by expression-position function literals and the IIFE
 *  wrapper). */
export function capture_body(status: BuildStatus, build: () => void): string {
	const saved_code = status.code;
	const saved_indent = status.indent;
	status.code = "";
	status.indent = saved_indent + 1;
	build();
	const body = status.code;
	status.code = saved_code;
	status.indent = saved_indent;
	return body;
}

/**
 * Emit a branch's statements. In value mode the branch's LAST statement is
 * its result: a trailing `let` wrapper (the parser's expression statement)
 * becomes `return <expr>;`, an explicit `return` stays as-is, and any other
 * statement is returned as an expression.
 */
export function branch_body(
	statements: BaseNode[],
	status: BuildStatus,
	value_mode: boolean,
): void {
	if (!value_mode) {
		for (const statement of statements) stmt(statement, status);
		return;
	}
	for (let i = 0; i < statements.length; i++) {
		const statement = statements[i];
		const is_last = i === statements.length - 1;
		if (!is_last) {
			stmt(statement, status);
			continue;
		}
		if (statement.node_type === "let") {
			const value = (statement as unknown as { value?: BaseNode }).value;
			emit(status, `return ${value ? expr(value, status) : "undefined"};`);
			return;
		}
		if (statement.node_type === "return") {
			stmt(statement, status);
			return;
		}
		emit(status, `return ${expr(statement, status)};`);
		return;
	}
	emit(status, "return undefined;");
}

/** Emit the JS expression text for a Nomen expression node. */
export function expr(node: BaseNode, status: BuildStatus): string {
	switch (node.node_type) {
		case "value":
			return build_value_node(node as ValueNode, status);
		case "op":
			return build_operation_node(node as OperationNode, status);
		case "if":
			return build_if_expression(node as IfElseNode, status);
		case "switch":
			return build_switch_expression(
				node as unknown as Parameters<typeof build_switch_expression>[0],
				status,
			);
		case "match":
			return build_match_expression(
				node as unknown as Parameters<typeof build_match_expression>[0],
				status,
			);
		case "cast":
			return build_cast_node(node as CastNode, status);
		case "access":
			return build_access_node(node as AccessNode, status);
		case "func_call":
			return build_function_call_node(node as FunctionCallNode, status);
		case "array":
			return build_array_values_node(node as ArrayValuesNode, status);
		case "grouped":
			return build_grouped_node(node as GroupedNode, status);
		case "func":
			return build_function_expression(node as FunctionNode, status);
		default:
			return `__skip(${JSON.stringify(`expression ${node.node_type}`)})`;
	}
}

/** Emit a Nomen statement node (with its checker-hoisted allocation temps). */
export function stmt(node: BaseNode, status: BuildStatus): void {
	// The checker hoists sub-expressions (interpolation parts, call args) into
	// `const` temps attached as `allocations`. They must be emitted before the
	// statement that consumes them; the walk is recursive because temps nest
	// (a builder's value, a branch's last expression, …).
	// Hoisted temps are inlined at their reference sites (build_value_node).

	switch (node.node_type) {
		case "declare":
			build_declaration_node(node as DeclarationNode, status);
			return;
		case "assign":
			build_assignment_node(node as AssignmentNode, status);
			return;
		case "if":
			build_if_else_node(node as IfElseNode, status);
			return;
		case "switch":
			build_switch_statement(
				node as unknown as Parameters<typeof build_switch_statement>[0],
				status,
			);
			return;
		case "match":
			build_match_statement(node as unknown as Parameters<typeof build_match_statement>[0], status);
			return;
		case "while":
			build_while_loop_node(node as WhileLoopNode, status);
			return;
		case "for":
			build_for_loop_node(node as ForLoopNode, status);
			return;
		case "return":
			build_return_node(node as ReturnNode, status);
			return;
		case "break":
			build_break_node(node, status);
			return;
		case "continue":
			build_continue_node(node, status);
			return;
		case "panic":
			build_panic_node(node as PanicNode, status);
			return;
		case "todo":
			build_todo_node(node as TodoNode, status);
			return;
		case "func":
			build_function_node(node as FunctionNode, status);
			return;
		case "struct":
			build_struct_node(node as StructNode, status);
			return;
		case "enum":
		case "bitset":
		case "trait":
		case "extend":
		case "import":
			// Declarations with no JS emission. Using their members falls back
			// to a warning stub at the call site.
			return;
		case "block":
			emit_block(node as BaseNode & { statements?: BaseNode[] }, status);
			return;
		case "let": {
			// `let` wraps an expression statement (see LetNode); emit the inner
			// expression as the statement.
			const value = (node as unknown as { value?: BaseNode }).value;
			if (value) stmt(value, status);
			return;
		}
		case "raw":
			return;
		default:
			emit(status, `${expr(node, status)};`);
	}
}

export function emit_block(
	node: BaseNode & { statements?: BaseNode[] },
	status: BuildStatus,
): void {
	emit(status, "{");
	status.indent += 1;
	for (const statement of node.statements ?? []) stmt(statement, status);
	status.indent -= 1;
	emit(status, "}");
}

export default function build_node(node: BaseNode, status: BuildStatus): void {
	stmt(node, status);
}
