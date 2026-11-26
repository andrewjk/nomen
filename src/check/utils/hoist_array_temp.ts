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
import { clone_type } from "./tuple_struct.ts";

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

/**
 * An array literal stored into a heap `Array<T>` slot (`x = [1, 2]`,
 * `self.xs = [1, 2]`): build it as a heap temp and hand it over, so the
 * store is `x = mv _param_N` (the temp is not freed at scope exit). A
 * nested literal is heap-built at every level already; a flat one needs
 * the heap-literal form.
 */
export function hoist_heap_array_literal(
	value: BaseNode,
	value_type: Type,
	slot_type: Type,
	status: CheckStatus,
): ValueNode {
	const name = `_param_${status.var_name_counter.value++}`;
	let decl_type = value_type;
	if (!slot_type.elem) {
		decl_type = clone_type(slot_type);
		decl_type.storage_kind = "heap_array";
		decl_type.length = undefined;
		decl_type.is_nullable_array = undefined;
	}
	const decl = new DeclarationNode(value.start, "private", "const", name, decl_type, value);
	if (!slot_type.elem) decl.is_heap_array_literal = true;
	status.allocations.push(decl);
	const read = new ValueNode(value.start, name, decl_type);
	read.is_moved = true;
	return read;
}

/** `(expr)` → `expr`. */
function ungroup(node: BaseNode): BaseNode {
	while (node.node_type === "grouped") node = (node as GroupedNode).value;
	return node;
}
