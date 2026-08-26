import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import type AccessFieldNode from "../nodes/AccessFieldNode.ts";
import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";

/**
 * The state a view-borrow classification needs. Both backends' BuildStatus
 * satisfy this shape, so the shared layer never imports a backend-specific
 * status type.
 */
export interface ViewValueStatus {
	structs: import("../nodes/StructNode.ts").default[];
	current_struct?: import("../nodes/StructNode.ts").default;
	variable_types?: Map<string, import("../nodes/Type.ts").default>;
	scoped_declarations: { name: string; type?: { name: string } }[];
	function_view_params?: Set<string>;
}

/**
 * Resolve the struct name of an expression's value by walking the access
 * chain through the (monomorphized) struct table — bare names via
 * variable_types / scoped declarations / `self`, field accesses via the
 * base struct's field type, method calls via the method's return type.
 * Fallback for cached node types that lost their modifiers (generic bodies
 * re-checked after monomorphization can carry a stale plain `string`).
 */
export function value_struct_name(node: BaseNode, status: ViewValueStatus): string | undefined {
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		if (name === "self" && status.current_struct) return status.current_struct.name;
		const vt = status.variable_types?.get(name);
		if (vt?.name) return vt.name;
		const decl = status.scoped_declarations.findLast((d) => d.name === name);
		if (decl?.type?.name) return decl.type.name;
		return undefined;
	}
	if (node.node_type === "access") {
		const inner = (node as AccessNode).access;
		const base = value_struct_name((node as AccessNode).target, status);
		if (!base) return undefined;
		const struct = status.structs.find((s) => s.name === base && !s.is_generic);
		if (!struct) return undefined;
		if (inner.node_type === "access_field") {
			const field = struct.fields.find((f) => f.name === (inner as AccessFieldNode).name);
			return field?.type?.name;
		}
		if (inner.node_type === "access_func") {
			const func = struct.functions.find((f) => f.name === (inner as AccessFunctionCallNode).name);
			return func?.return_type?.name;
		}
	}
	return undefined;
}

/**
 * Whether an expression is a `view T` VALUE — a non-owning borrow that can
 * pass through a `view T` parameter unchanged. Recovers `is_view` from the
 * cached node type, the declared variable type, the current function's view
 * params, or (for method calls whose cached type lost the modifier) the
 * callee's declared return type. This is THE definition of view-borrowness;
 * both backends previously kept byte-identical copies and drifted.
 */
export function is_view_value(node: BaseNode, status: ViewValueStatus): boolean {
	if (type_from_value_node(node)?.is_view) return true;
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		if (status.variable_types?.get(name)?.is_view) return true;
		if (status.function_view_params?.has(name)) return true;
	}
	if (node.node_type === "access" && (node as AccessNode).access.node_type === "access_func") {
		const access = (node as AccessNode).access as AccessFunctionCallNode;
		const recv_struct = value_struct_name((node as AccessNode).target, status);
		const struct = status.structs.find((s) => s.name === recv_struct && !s.is_generic);
		const func = struct?.functions.find(
			(f) => f.name === access.name || f.name === `#${access.name}`,
		);
		if (func?.return_type?.is_view) return true;
	}
	return false;
}
