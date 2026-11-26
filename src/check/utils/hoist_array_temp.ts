import { is_array_copy_call } from "../../build_common/element_copy.ts";
import type AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import type AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import DeclarationNode from "../../nodes/DeclarationNode.ts";
import type FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import type GroupedNode from "../../nodes/GroupedNode.ts";
import type Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";

/**
 * True for a checked call that hands back a fresh heap array its caller
 * owns: `xs.copy()`, `xs + ys` / `xs * n` (lowered to `add` / `mul`),
 * `Array<T>.with(v, n)`, or a free function returning an array.
 */
export function is_owned_array_call(node: BaseNode): boolean {
	node = ungroup(node);
	if (is_array_copy_call(node)) return true;
	if (node.node_type === "func_call") {
		return !!(node as FunctionCallNode).resolved_function?.return_type?.is_array;
	}
	if (node.node_type !== "access") return false;
	const access = (node as AccessNode).access;
	if (access.node_type !== "access_func") return false;
	const call = access as AccessFunctionCallNode;
	if (call.nested_with || call.nested_op) return true;
	return call.name === "with" && !!call.type?.is_array;
}

/**
 * Bind an owned array call result to a `_param_N` const and return a read
 * of it. A bare call result has no home the backends can read `.length`
 * from or free after use (`(xs + ys).length`, `(xs * 2) + ys`); a named
 * local has both, and its scope-exit cleanup frees it.
 */
export function hoist_array_temp(value: BaseNode, type: Type, status: CheckStatus): BaseNode {
	const name = `_param_${status.var_name_counter.value++}`;
	const call = ungroup(value);
	status.allocations.push(new DeclarationNode(value.start, "private", "const", name, type, call));
	return new ValueNode(value.start, name, type);
}

/** `(expr)` → `expr`. */
function ungroup(node: BaseNode): BaseNode {
	while (node.node_type === "grouped") node = (node as GroupedNode).value;
	return node;
}
