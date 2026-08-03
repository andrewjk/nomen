import DeclarationNode from "../../nodes/DeclarationNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * Hoist any non-value params that produce a struct rvalue into temporary
 * `_param_N` declarations.
 *
 * Auto-generated tuple and anon-struct constructors (created in
 * check_array_values_node / check_anon_struct) bypass the normal parameter
 * hoisting in check_function_call. Without this, struct rvalues (e.g. a
 * nested tuple constructor result) reach the C backend, which emits
 * `(void *)&<rvalue>` — invalid C (cannot take the address of an rvalue).
 *
 * After hoisting, the builder sees an lvalue (`_param_N`) and can safely
 * take its address.
 */
export default function hoist_struct_params(
	constructor: FunctionCallNode,
	status: CheckStatus,
): void {
	for (let i = 0; i < constructor.params.length; i++) {
		const param = constructor.params[i];
		if (param.node_type === "value") continue;
		const param_type = type_from_value_node(param, status);
		if (!param_type.name) continue;
		const is_struct = !!status.structs.find(
			(s) => s.name === param_type.name && !s.is_simple_type && !s.is_class,
		);
		if (!is_struct) continue;

		const declaration_name = `_param_${status.var_name_counter.value++}`;
		const hoisted = new DeclarationNode(
			param.start,
			"private",
			"const",
			declaration_name,
			param_type,
			param,
		);
		status.allocations.push(hoisted);
		constructor.params[i] = new ValueNode(param.start, declaration_name, param_type);
	}
}
