import add_error from "../add_error.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import Type from "../nodes/Type.ts";
import check_function_call from "./check_function_call.ts";
import type CheckStatus from "./CheckStatus.ts";

export default function check_function_call_node(
	node: FunctionCallNode,
	status: CheckStatus,
): boolean {
	let func = status.functions.findLast((f) => f.name === node.name);

	if (!func) {
		const struct = status.structs.findLast((s) => s.name === node.name);
		if (struct) {
			func = struct.functions.find((f) => f.name === "init");
			if (func) {
				const type = new Type(struct.name);
				type.type_args = node.type_args;
				node.type = type;
			}
		}
	}

	if (!func && node.name.startsWith("_string_interpolate_")) {
		const length = parseInt(node.name.substring("_string_interpolate_".length));
		func = new FunctionNode(0, "pub", node.name, node.type, [
			new ParameterNode(0, "pattern"),
			...Array.from({ length }, (_, i) => new ParameterNode(0, `arg${i + 1}`)),
		]);
	}

	if (!func) {
		const param_value = status.values.findLast((v) => v.name === node.name);
		if (param_value?.type.name === "func") {
			func = new FunctionNode(0, "pub", node.name, param_value.type);
			const param = status.stack
				.flatMap((n: any) => n.params || [])
				.find((p: any) => p.name === node.name);
			if (param?.func_params) {
				func.params = param.func_params;
			}
			if (param?.func_return_type) {
				func.return_type = param.func_return_type;
			}
			node.is_func_param = true;
		}
	}

	if (!func) {
		add_error(status, `Function not found: ${node.name}`, node.start);
		return false;
	}

	return check_function_call(node, status, func);
}
