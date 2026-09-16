import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import CastNode from "../nodes/CastNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import GroupedNode from "../nodes/GroupedNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import LetNode from "../nodes/LetNode.ts";
import MatchNode from "../nodes/MatchNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import WhileLoopNode from "../nodes/WhileLoopNode.ts";

export interface CollectAllocationsOptions {
	/**
	 * Walk LetNode values. The C backend's statement hoisting needs a
	 * LetNode's value allocations to surface BEFORE the let emits its
	 * `<target> = ` prefix under `status.return_assign` — otherwise the
	 * hoisted declaration lands mid-expression (invalid C). The aarch64
	 * emission never materializes a LetNode as a statement, so it leaves
	 * this off (byte-stable with the pre-extraction walks).
	 */
	let_values?: boolean;
}

/**
 * Recursively collects the allocation declarations attached to a node
 * and its children — the shared walk behind both backends'
 * `emit_allocations` (phase-3 leftover extraction, ASM_PLAN_4 item 5).
 * Neither backend clears `node.allocations`: the AST is shared between
 * builds, and duplicate emission within one build is prevented by
 * `status.emitted_allocations` at the call sites.
 */
export default function collect_allocations(
	node: BaseNode,
	options?: CollectAllocationsOptions,
): BaseNode[] {
	if (!node) return [];
	let result: BaseNode[] = [];

	// Collect this node's own allocations (without clearing — see header).
	if (node.allocations && node.allocations.length > 0) {
		result.push(...node.allocations);
	}

	// Recurse into children
	switch (node.node_type) {
		case "op": {
			const op = node as OperationNode;
			result.push(...collect_allocations(op.left_value, options));
			result.push(...collect_allocations(op.right_value, options));
			break;
		}
		case "assign": {
			const assign = node as AssignmentNode;
			result.push(...collect_allocations(assign.left_value, options));
			result.push(...collect_allocations(assign.right_value, options));
			if (assign.swap) result.push(...collect_allocations(assign.swap, options));
			break;
		}
		case "declare": {
			const decl = node as DeclarationNode;
			if (decl.value) result.push(...collect_allocations(decl.value, options));
			break;
		}
		case "let": {
			if (options?.let_values) {
				result.push(...collect_allocations((node as LetNode).value, options));
			}
			break;
		}
		case "func_call": {
			const call = node as FunctionCallNode;
			for (const param of call.params) {
				result.push(...collect_allocations(param, options));
			}
			break;
		}
		case "access": {
			const access = node as AccessNode;
			result.push(...collect_allocations(access.target, options));
			if (access.access.node_type === "access_func") {
				const func = access.access as AccessFunctionCallNode;
				for (const param of func.params) {
					result.push(...collect_allocations(param, options));
				}
			}
			break;
		}
		case "grouped": {
			result.push(...collect_allocations((node as GroupedNode).value, options));
			break;
		}
		case "cast": {
			result.push(...collect_allocations((node as CastNode).value, options));
			break;
		}
		case "return": {
			const ret = node as ReturnNode;
			if (ret.value) result.push(...collect_allocations(ret.value, options));
			break;
		}
		case "if": {
			const ifElse = node as IfElseNode;
			result.push(...collect_allocations(ifElse.condition, options));
			// Don't recurse into branches — they're blocks with their own boundaries
			break;
		}
		case "match": {
			// The scrutinee is captured as a single expression by the C backend
			// (build_match_node builds it into a temp string), so any argument
			// temporaries hoisted by the checker (`_param_N`) must surface at the
			// statement boundary BEFORE the match emits its temp initializer —
			// otherwise the declaration lands mid-expression (invalid C). Branch
			// blocks are boundaries of their own; don't recurse into them.
			result.push(...collect_allocations((node as MatchNode).value, options));
			break;
		}
		case "while": {
			const whileLoop = node as WhileLoopNode;
			result.push(...collect_allocations(whileLoop.condition, options));
			if (whileLoop.update) result.push(...collect_allocations(whileLoop.update, options));
			break;
		}
		case "switch": {
			const switchNode = node as SwitchNode;
			for (const c of switchNode.cases) {
				result.push(...collect_allocations(c.condition, options));
			}
			break;
		}
		case "range": {
			const range = node as RangeNode;
			result.push(...collect_allocations(range.left_value, options));
			result.push(...collect_allocations(range.right_value, options));
			break;
		}
		case "array": {
			const arr = node as ArrayValuesNode;
			for (const val of arr.values) {
				result.push(...collect_allocations(val, options));
			}
			break;
		}
	}

	return result;
}
