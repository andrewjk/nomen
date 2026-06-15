import add_error from "../add_error.ts";
import type ReturningNode from "../nodes/ReturningNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

function is_class_type(type_name: string, status: CheckStatus): boolean {
	return !!status.structs.find((s) => s.name === type_name && s.is_class);
}

function get_inner_value_node(node: import("../nodes/BaseNode.ts").default): ValueNode | null {
	if (node.node_type === "value") return node as ValueNode;
	if (node.node_type === "grouped") return get_inner_value_node((node as any).value);
	return null;
}

export default function check_return_node(ret: ReturnNode, status: CheckStatus) {
	let func: ReturningNode | null = null;
	for (let i = status.stack.length - 1; i >= 0; i--) {
		if (status.stack[i].node_type === "func") {
			func = status.stack[i] as ReturningNode;
			break;
		}
	}

	if (!ret.value) {
		if (func && !func.return_type.name) {
			func.return_type = new Type("void");
		}
		ret.type = new Type("void");
		return;
	}

	const old_expected_type = status.expected_type;
	if (func?.return_type?.name && func.return_type.name !== "?") {
		status.expected_type = func.return_type;
	}

	if (!check_node(ret.value, status)) {
		status.expected_type = old_expected_type;
		return;
	}
	status.expected_type = old_expected_type;

	ret.type = type_from_value_node(ret.value, status);

	if (func && ret.type && is_class_type(ret.type.name, status)) {
		const value_node = get_inner_value_node(ret.value);
		if (value_node) {
			const param = (func as import("../nodes/FunctionNode.ts").default).params.find(
				(p) => p.name === value_node.value,
			);
			if (param && is_class_type(param.type.name, status) && !param.is_moved) {
				add_error(
					status,
					`Cannot return class parameter '${param.name}' without 'mov' — would create shared reference`,
					ret.value.start,
				);
			}
		}
	}

	if (func) {
		if (func.return_type.name) {
			if (func.return_type.name !== "?") {
				const return_type = type_from_value_node(ret.value, status);
				const return_value = value_from_value_node(ret.value);
				const error_pos = ret.value.node_type === "grouped" ? ret.start + 2 : ret.value.start;
				check_type_and_value_match(
					func.return_type,
					return_type,
					return_value,
					status,
					error_pos,
					"return",
				);
				func.return_type.is_static = return_type.is_static;
			}
		} else {
			func.return_type = ret.type;
		}
	}
}
