import { is_box_type } from "../check/utils/box.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import type StructNode from "../nodes/StructNode.ts";

/**
 * STRUCT_PLAN_3 Box elision: when a `Box<T>(...)` construction's single
 * `__value` argument is a DIRECT constructor call of the wrapped type
 * (`Box<TreeNode>(TreeNode())` — `mv` on the fresh rvalue changes nothing),
 * the argument can build straight into the freshly malloc'd box slot instead
 * of materializing a stack value that the box ctor memcpy's in. Returns the
 * inner constructor call to build in place, or undefined when the call must
 * lower normally (a named donor moves byte-wise; anything else keeps the
 * hoisted-temp + `_init` copy path).
 *
 * The inner call must be a VALUE-struct constructor of exactly the field's
 * (monomorphized) type — a class-typed field rides as a pointer and has no
 * copy to elide, and a non-constructor call result has donor ownership
 * records the in-place shape cannot transfer.
 */
export function box_ctor_direct_ctor_arg(
	node: FunctionCallNode,
	structs: readonly StructNode[],
): FunctionCallNode | undefined {
	if (!is_box_type(node.name, structs)) return undefined;
	if (node.params.length !== 1) return undefined;
	const param = node.params[0];
	if (param.node_type !== "func_call") return undefined;
	const inner = param as FunctionCallNode;
	if (inner.name !== node.name) {
		// The wrapper's mono name (Box_TreeNode) and the field's type share
		// the same suffix; compare against the field type directly.
		const box_struct = structs.find((s) => s.name === node.name);
		const field_type = box_struct?.fields[0]?.type?.name;
		if (inner.name !== field_type) return undefined;
	}
	const inner_struct = structs.find(
		(s) => s.name === inner.name && !s.is_simple_type && !s.is_class,
	);
	if (!inner_struct) return undefined;
	if (inner.field_overrides?.length) return undefined;
	return inner;
}
