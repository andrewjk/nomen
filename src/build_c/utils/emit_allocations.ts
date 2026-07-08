import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import ArrayValuesNode from "../../nodes/ArrayValuesNode.ts";
import AssignmentNode from "../../nodes/AssignmentNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import CastNode from "../../nodes/CastNode.ts";
import DeclarationNode from "../../nodes/DeclarationNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import GroupedNode from "../../nodes/GroupedNode.ts";
import IfElseNode from "../../nodes/IfElseNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import RangeNode from "../../nodes/RangeNode.ts";
import ReturnNode from "../../nodes/ReturnNode.ts";
import SwitchNode from "../../nodes/SwitchNode.ts";
import WhileLoopNode from "../../nodes/WhileLoopNode.ts";
import build_node from "../build_node.ts";
import type BuildStatus from "../BuildStatus.ts";

/**
 * Recursively collects all allocation declarations attached to a node and its
 * children, builds them as separate C statements, and clears them from the
 * nodes so they won't be emitted inline during the subsequent build.
 *
 * This solves the problem of function-call argument temporaries ending up
 * inside expressions (if/while conditions, assignment RHS, etc.), which would
 * be invalid C.
 */
export default function emit_allocations(node: BaseNode, status: BuildStatus) {
	const allocations = collect_and_clear_allocations(node);
	for (const alloc of allocations) {
		build_node(alloc, status, true);
	}
}

function collect_and_clear_allocations(node: BaseNode): BaseNode[] {
	if (!node) return [];
	let result: BaseNode[] = [];

	// Collect and clear this node's own allocations
	if (node.allocations && node.allocations.length > 0) {
		result.push(...node.allocations);
		node.allocations = [];
	}

	// Recurse into children
	switch (node.node_type) {
		case "op": {
			const op = node as OperationNode;
			result.push(...collect_and_clear_allocations(op.left_value));
			result.push(...collect_and_clear_allocations(op.right_value));
			break;
		}
		case "assign": {
			const assign = node as AssignmentNode;
			result.push(...collect_and_clear_allocations(assign.left_value));
			result.push(...collect_and_clear_allocations(assign.right_value));
			if (assign.swap) result.push(...collect_and_clear_allocations(assign.swap));
			break;
		}
		case "declare": {
			const decl = node as DeclarationNode;
			if (decl.value) result.push(...collect_and_clear_allocations(decl.value));
			break;
		}
		case "func_call": {
			const call = node as FunctionCallNode;
			for (const param of call.params) {
				result.push(...collect_and_clear_allocations(param));
			}
			break;
		}
		case "access": {
			const access = node as AccessNode;
			result.push(...collect_and_clear_allocations(access.target));
			if (access.access.node_type === "access_func") {
				const func = access.access as AccessFunctionCallNode;
				for (const param of func.params) {
					result.push(...collect_and_clear_allocations(param));
				}
			}
			break;
		}
		case "grouped": {
			result.push(...collect_and_clear_allocations((node as GroupedNode).value));
			break;
		}
		case "cast": {
			result.push(...collect_and_clear_allocations((node as CastNode).value));
			break;
		}
		case "return": {
			const ret = node as ReturnNode;
			if (ret.value) result.push(...collect_and_clear_allocations(ret.value));
			break;
		}
		case "if": {
			const ifElse = node as IfElseNode;
			result.push(...collect_and_clear_allocations(ifElse.condition));
			// Don't recurse into branches — they're blocks with their own boundaries
			break;
		}
		case "while": {
			const whileLoop = node as WhileLoopNode;
			result.push(...collect_and_clear_allocations(whileLoop.condition));
			if (whileLoop.update) result.push(...collect_and_clear_allocations(whileLoop.update));
			break;
		}
		case "switch": {
			const switchNode = node as SwitchNode;
			for (const c of switchNode.cases) {
				result.push(...collect_and_clear_allocations(c.condition));
			}
			break;
		}
		case "range": {
			const range = node as RangeNode;
			result.push(...collect_and_clear_allocations(range.left_value));
			result.push(...collect_and_clear_allocations(range.right_value));
			break;
		}
		case "array": {
			const arr = node as ArrayValuesNode;
			for (const val of arr.values) {
				result.push(...collect_and_clear_allocations(val));
			}
			break;
		}
	}

	return result;
}
