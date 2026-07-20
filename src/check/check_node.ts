import add_error from "../add_error.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AnonStructNode from "../nodes/AnonStructNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import AsyncBlockNode from "../nodes/AsyncBlockNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import BitsetNode from "../nodes/BitsetNode.ts";
import BreakNode from "../nodes/BreakNode.ts";
import CastNode from "../nodes/CastNode.ts";
import { is_block_node } from "../nodes/check_node_type.ts";
import ContinueNode from "../nodes/ContinueNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import EnumNode from "../nodes/EnumNode.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import GroupedNode from "../nodes/GroupedNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import LetNode from "../nodes/LetNode.ts";
import MatchNode from "../nodes/MatchNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import RootNode from "../nodes/RootNode.ts";
import SpawnNode from "../nodes/SpawnNode.ts";
import StructNode from "../nodes/StructNode.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";
import check_access_node from "./check_access_node.ts";
import check_async_block_node from "./check_async_block_node.ts";
import check_array_values_node from "./check_array_values_node.ts";
import check_assignment_node from "./check_assignment_node.ts";
import check_bitset_node from "./check_bitset_node.ts";
import check_block_node from "./check_block_node.ts";
import check_break_or_continue_node from "./check_break_or_continue_node.ts";
import check_cast_node from "./check_cast_node.ts";
import check_declaration_node from "./check_declaration_node.ts";
import check_enum_node from "./check_enum_node.ts";
import check_for_loop_node from "./check_for_loop_node.ts";
import check_function_call_node from "./check_function_call_node.ts";
import check_function_node from "./check_function_node.ts";
import check_if_else_node from "./check_if_else_node.ts";
import check_let_node from "./check_let_node.ts";
import check_match_node from "./check_match_node.ts";
import check_operation_node from "./check_operation_node.ts";
import check_range_node from "./check_range_node.ts";
import check_return_node from "./check_return_node.ts";
import check_spawn_node from "./check_spawn_node.ts";
import check_struct_node from "./check_struct_node.ts";
import check_switch_node from "./check_switch_node.ts";
import check_trait_node from "./check_trait_node.ts";
import check_value_node from "./check_value_node.ts";
import check_while_loop_node from "./check_while_loop_node.ts";
import type CheckStatus from "./CheckStatus.ts";

export default function check_node(node: BaseNode, status: CheckStatus): boolean {
	let result = true;

	switch (node.node_type) {
		case "root": {
			check_block_node(node as RootNode, status);
			break;
		}
		case "struct": {
			check_struct_node(node as StructNode, status);
			break;
		}
		case "trait": {
			check_trait_node(node as TraitNode, status);
			break;
		}
		case "enum": {
			check_enum_node(node as EnumNode, status);
			break;
		}
		case "bitset": {
			check_bitset_node(node as BitsetNode, status);
			break;
		}
		case "func": {
			check_function_node(node as FunctionNode, status);
			break;
		}
		case "declare": {
			check_declaration_node(node as DeclarationNode, status);
			break;
		}
		case "assign": {
			check_assignment_node(node as AssignmentNode, status);
			break;
		}
		case "func_call": {
			result = check_function_call_node(node as FunctionCallNode, status);
			break;
		}
		case "access": {
			result = check_access_node(node as AccessNode, status);
			break;
		}
		case "if": {
			check_if_else_node(node as IfElseNode, status);
			break;
		}
		case "cast": {
			check_cast_node(node as CastNode, status);
			break;
		}
		case "match": {
			check_match_node(node as MatchNode, status);
			break;
		}
		case "switch": {
			check_switch_node(node as SwitchNode, status);
			break;
		}
		case "for": {
			check_for_loop_node(node as ForLoopNode, status);
			break;
		}
		case "while": {
			check_while_loop_node(node as WhileLoopNode, status);
			break;
		}
		case "grouped": {
			result = check_node((node as GroupedNode).value, status);
			break;
		}
		case "op": {
			result = check_operation_node(node as OperationNode, status);
			break;
		}
		case "array": {
			result = check_array_values_node(node as ArrayValuesNode, status);
			break;
		}
		case "range": {
			result = check_range_node(node as RangeNode, status);
			break;
		}
		case "value": {
			result = check_value_node(node as ValueNode, status);
			break;
		}
		case "break": {
			check_break_or_continue_node(node as BreakNode, status);
			break;
		}
		case "continue": {
			check_break_or_continue_node(node as ContinueNode, status);
			break;
		}
		case "panic":
		case "todo": {
			// todo
			break;
		}
		case "return": {
			check_return_node(node as ReturnNode, status);
			break;
		}
		case "let": {
			check_let_node(node as LetNode, status);
			break;
		}
		case "raw": {
			// Anything can go in here
			break;
		}
		case "spawn": {
			result = check_spawn_node(node as SpawnNode, status);
			break;
		}
		case "async_block": {
			check_async_block_node(node as AsyncBlockNode, status);
			break;
		}
		case "anon_struct": {
			const anon = node as AnonStructNode;
			for (const field of anon.fields) {
				result = check_node(field.value, status) && result;
			}
			break;
		}
		default: {
			add_error(status, `Unknown node type: ${node.node_type}`, node.start);
			result = false;
			break;
		}
	}

	promote_allocations(node, status);

	return result;
}

function promote_allocations(node: BaseNode, status: CheckStatus) {
	// If allocations have been hoisted out of e.g. function params in a child of
	// this node, and the parent of this node is a block node, add the allocations
	// to this node so that they will be declared in the block node, before they
	// are used in this node
	// E.g. something like
	// func print() {
	//   ...
	//   const z = "\{5}..."
	// }
	// will become
	// func print() {
	//   ...
	//   const _param_1 = 5.to_string()
	//   const z = _string_interpolate("%s...", _param_1)
	//   free(_param_1)
	// }
	if (status.allocations.length) {
		let parent = status.stack.at(-1);
		if (is_block_node(parent)) {
			node.allocations ??= [];
			node.allocations.push(...status.allocations);
			// HACK: We need allocations to be cleared in the status that this one may
			// have been cloned from, so we can't just set status.allocations = []
			status.allocations.length = 0;
		}
	}
}
