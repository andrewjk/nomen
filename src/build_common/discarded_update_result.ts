import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import GroupedNode from "../nodes/GroupedNode.ts";
import type Type from "../nodes/Type.ts";
import { struct_needs_destroy } from "./destroy_analysis.ts";
import { resolve_struct_type, type StructTable } from "./mono_name.ts";

/**
 * The owned result type of a `while` POST-STATEMENT (update) expression whose
 * discarded value must be reclaimed once per iteration.
 *
 * This is the update-position twin of the checker's bare-statement `_disc_N`
 * hoist (`hoist_discarded_class_results`) — but the hoist itself cannot run
 * here: the update re-evaluates on every iteration, so wrapping it in a
 * one-shot declaration would run the call before the first condition check
 * and change loop semantics. Instead, each backend captures the fresh result
 * into a per-iteration temp and frees it in place.
 *
 * Predicate mirrors the hoist's: a free-function call (`func_call`) whose
 * result type is a class or an owning value struct (`string` included), or a
 * method call whose callee stamps `owned_return` (`mv out T`). A view / ref /
 * array result is a borrow — never an owner — and a nullable VALUE struct's
 * sret-plus-flag shape has no in-place free, so both stay out.
 */
export default function discarded_owned_result_type(
	node: BaseNode,
	table: StructTable,
): Type | undefined {
	let expr = node;
	while (expr.node_type === "grouped") expr = (expr as GroupedNode).value;
	const is_call = expr.node_type === "func_call";
	const is_method =
		expr.node_type === "access" && (expr as AccessNode).access.node_type === "access_func";
	if (!is_call && !is_method) return undefined;
	const access_func = is_method ? ((expr as AccessNode).access as AccessFunctionCallNode) : null;
	if (access_func && !access_func.owned_return) return undefined;
	const t = is_call ? (expr as FunctionCallNode).type : access_func!.type;
	if (!t?.name || t.is_view || t.is_ref || t.is_array) return undefined;
	// `string` is the mv struct the backends lower as a primitive fat pair —
	// it keeps a built-in `is_simple_type` stamp the generic resolver
	// excludes, so it resolves by name (D3: the pair owns its bytes).
	if (t.name === "string") return t;
	const struct = resolve_struct_type(t, table);
	if (!struct) return undefined;
	if (struct.is_class) return t;
	if (t.is_nullable) return undefined;
	if (struct_needs_destroy(struct, table)) return t;
	return undefined;
}
