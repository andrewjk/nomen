import type BuildStatus from "../build/BuildStatus.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import CastNode from "../nodes/CastNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import GroupedNode from "../nodes/GroupedNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import MatchNode from "../nodes/MatchNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import PanicNode from "../nodes/PanicNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import RawNode from "../nodes/RawNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import RootNode from "../nodes/RootNode.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import TodoNode from "../nodes/TodoNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import build_access_node from "./build_access_node.ts";
import build_array_values_node from "./build_array_values_node.ts";
import build_assignment_node from "./build_assignment_node.ts";
import build_block_node from "./build_block_node.ts";
import build_break_node from "./build_break_node.ts";
import build_cast_node from "./build_cast_node.ts";
import build_continue_node from "./build_continue_node.ts";
import build_declaration_node from "./build_declaration_node.ts";
import build_for_loop_node from "./build_for_loop_node.ts";
import build_function_call_node from "./build_function_call_node.ts";
import build_function_node from "./build_function_node.ts";
import build_if_else_node from "./build_if_else_node.ts";
import build_match_node from "./build_match_node.ts";
import build_operation_node from "./build_operation_node.ts";
import build_panic_node from "./build_panic_node.ts";
import build_range_node from "./build_range_node.ts";
import build_raw_node from "./build_raw_node.ts";
import build_return_node from "./build_return_node.ts";
import build_switch_node from "./build_switch_node.ts";
import build_todo_node from "./build_todo_node.ts";
import build_value_node from "./build_value_node.ts";
import build_while_loop_node from "./build_while_loop_node.ts";

export default function build_node(node: BaseNode, status: BuildStatus, with_semicolon = false) {
	if (node.allocations) {
		for (let decl of node.allocations) {
			build_node(decl, status, true);
		}
	}

	switch (node.node_type) {
		case "root": {
			build_block_node(node as RootNode, status);
			break;
		}
		case "declare": {
			const decl = node as DeclarationNode;
			build_declaration_node(decl, status);
			if (decl.value?.node_type === "func") {
				with_semicolon = false;
			}
			break;
		}
		case "assign": {
			build_assignment_node(node as AssignmentNode, status);
			break;
		}
		case "func": {
			build_function_node(node as FunctionNode, status);
			with_semicolon = false;
			break;
		}
		case "func_call": {
			build_function_call_node(node as FunctionCallNode, status);
			break;
		}
		case "grouped": {
			build_node((node as GroupedNode).value, status);
			break;
		}
		case "op": {
			build_operation_node(node as OperationNode, status);
			break;
		}
		case "if": {
			build_if_else_node(node as IfElseNode, status);
			with_semicolon = false;
			break;
		}
		case "cast": {
			build_cast_node(node as CastNode, status);
			break;
		}
		case "match": {
			build_match_node(node as MatchNode, status);
			with_semicolon = false;
			break;
		}
		case "switch": {
			build_switch_node(node as SwitchNode, status);
			with_semicolon = false;
			break;
		}
		case "for": {
			build_for_loop_node(node as ForLoopNode, status);
			with_semicolon = false;
			break;
		}
		case "while": {
			build_while_loop_node(node as WhileLoopNode, status);
			with_semicolon = false;
			break;
		}
		case "break": {
			build_break_node(status);
			break;
		}
		case "continue": {
			build_continue_node(status);
			break;
		}
		case "return": {
			build_return_node(node as ReturnNode, status);
			break;
		}
		case "value": {
			build_value_node(node as ValueNode, status);
			break;
		}
		case "array": {
			build_array_values_node(node as ArrayValuesNode, status);
			break;
		}
		case "range": {
			build_range_node(node as RangeNode, status);
			break;
		}
		case "access": {
			build_access_node(node as AccessNode, status);
			break;
		}
		case "panic": {
			build_panic_node(node as PanicNode, status);
			break;
		}
		case "todo": {
			build_todo_node(node as TodoNode, status);
			break;
		}
		case "raw": {
			build_raw_node(node as RawNode, status);
			with_semicolon = false;
			break;
		}
		default: {
			throw Error("Invalid node: " + node.node_type);
		}
	}

	if (with_semicolon) {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
	}
}
