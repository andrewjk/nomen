import add_error from "../add_error.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_function_call(
	node: FunctionCallNode | AccessFunctionCallNode,
	status: CheckStatus,
	func: FunctionNode,
	target_type?: Type,
): boolean {
	if (
		func.visibility === "priv" &&
		!status.structs.find((s) => s.name === target_type?.name)?.privates_visible
	) {
		add_error(status, `Can't access priv function: ${node.name}`, node.start);
		return false;
	}

	node.type = func.return_type;
	node.is_static = func.is_static;

	let required_param_count = 0;
	for (const param of func.params) {
		if (!param.default_value) {
			required_param_count++;
		}
	}
	if (target_type && func.params[0]?.is_self_param) {
		required_param_count -= 1;
	}
	if (node.params.length > func.params.length) {
		add_error(status, `Too many parameters for function: ${node.name}`, node.start);
		return false;
	} else if (node.params.length < required_param_count) {
		add_error(status, `Parameters missing for function: ${node.name}`, node.start);
		return false;
	}

	while (node.params.length < func.params.length) {
		const missing_param = func.params[node.params.length];
		if (missing_param.default_value) {
			node.params.push(missing_param.default_value);
		} else {
			break;
		}
	}

	status.stack.push(node);

	for (let [i, param] of node.params.entries()) {
		if (!check_node(param, status)) {
			continue;
		}

		const param_type = type_from_value_node(param, status);
		const param_value = value_from_value_node(param);
		check_type_and_value_match(
			func.params[i].type,
			param_type,
			param_value,
			status,
			param.start,
			"param",
		);

		if (param_type.is_array && param_type.length && !func.params[i].type.length) {
			func.params[i].type.length = param_type.length;
		}

		if (param.node_type !== "value") {
			const declaration_name = `_param_${status.var_name_counter.value++}`;
			status.allocations.push(
				new DeclarationNode(param.start, "priv", "const", declaration_name, param_type, param),
			);
			node.params.splice(i, 1, new ValueNode(param.start, declaration_name, param_type));
		}
	}

	status.stack.pop();

	return true;
}
