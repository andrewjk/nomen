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
import build_function_node from "./build_function_node.ts";
import build_grouped_node from "./build_grouped_node.ts";
import build_if_else_node from "./build_if_else_node.ts";
import build_operation_node from "./build_operation_node.ts";
import build_panic_node from "./build_panic_node.ts";
import build_return_node from "./build_return_node.ts";
import build_struct_node from "./build_struct_node.ts";
import build_todo_node from "./build_todo_node.ts";
import build_value_node from "./build_value_node.ts";
import build_while_loop_node from "./build_while_loop_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/** Append a statement line at the current indentation. */
export function emit(status: BuildStatus, text: string): void {
	status.code += "\t".repeat(status.indent) + text + "\n";
}

/** Emit the JS expression text for a Nomen expression node. */
export function expr(node: BaseNode, status: BuildStatus): string {
	switch (node.node_type) {
		case "value":
			return build_value_node(node as ValueNode, status);
		case "op":
			return build_operation_node(node as OperationNode, status);
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
		default:
			return `__unsupported(${JSON.stringify(`expression ${node.node_type}`)})`;
	}
}

/** Emit a Nomen statement node (with its checker-hoisted allocation temps). */
export function stmt(node: BaseNode, status: BuildStatus): void {
	// The checker hoists sub-expressions (interpolation parts, call args) into
	// per-statement `const` temps attached as `allocations`. They must be
	// emitted before the statement that consumes them.
	for (const allocation of (node as unknown as { allocations?: BaseNode[] }).allocations ?? []) {
		stmt(allocation, status);
	}

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
			// v1: declarations with no JS emission. Using their members fails
			// loudly at the call site (`__unsupported`).
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
