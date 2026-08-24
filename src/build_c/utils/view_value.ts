import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import build_node from "../build_node.ts";
import type BuildStatus from "../BuildStatus.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * Resolve the struct name of an expression's value by walking the access
 * chain through the (monomorphized) struct table — bare names via
 * variable_types / scoped declarations / `self`, field accesses via the
 * base struct's field type, method calls via the method's return type.
 * Fallback for cached node types that lost their modifiers (generic bodies
 * re-checked after monomorphization can carry a stale plain `string`).
 */
function value_struct_name(node: BaseNode, status: BuildStatus): string | undefined {
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
 * Whether an expression is a `view T` VALUE at the C level — a nomen_view
 * (ptr, len) struct expression that can pass through a `view T` parameter
 * unchanged. Recovers `is_view` from the cached node type, the declared
 * variable type, the current function's view params, or (for method calls
 * whose cached type lost the modifier) the callee's declared return type.
 */
export function is_view_value(node: BaseNode, status: BuildStatus): boolean {
	const t = type_from_value_node(node);
	if (t?.is_view) return true;
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

/**
 * Emit a C expression for an argument passed to a `view string` parameter.
 * A view-typed argument is already a nomen_view — pass it through. An owned
 * `string` expression is a fat nomen_string; borrowing it into a view is a
 * plain (ptr, len) struct copy — no strlen, no allocation (the caller keeps
 * ownership of the string).
 */
export function c_view_string_arg(arg: BaseNode, status: BuildStatus) {
	if (is_view_value(arg, status)) {
		build_node(arg, status);
		return;
	}
	status.code += `({ nomen_string _p = `;
	build_node(arg, status);
	status.code += `; nomen_view _v = { (void*)_p.ptr, _p.len }; _v; })`;
}

/**
 * Emit a C expression materializing a `view string` into an OWNED heap
 * string (malloc len+1 / memcpy / null-terminate). Used when a view value
 * initializes an owned `string` declaration (`const string s = v`) — the
 * resulting pointer is heap-owned and must be freed at scope exit.
 */
export function c_materialize_view_string(arg: BaseNode, status: BuildStatus) {
	status.code += `({ nomen_view _t = `;
	build_node(arg, status);
	status.code += `; char* _r = malloc(_t.len + 1); memcpy(_r, _t.ptr, _t.len); _r[_t.len] = 0; (nomen_string){ _r, _t.len }; })`;
}
