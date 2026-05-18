import add_error from "../add_error.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import type CheckStatus from "./CheckStatus.ts";
import type_from_value from "./utils/type_from_value.ts";

export default function check_value_node(node: ValueNode, status: CheckStatus): boolean {
	if (node.value === "null") {
		node.type = new Type("null", true);
		node.type.is_nullable = true;
		return true;
	}

	node.type = type_from_value(node.value, status);

	if (!node.type.name) {
		add_error(status, `Unknown value: ${node.value}`, node.start);
		return false;
	}

	const decl_value = status.values.findLast((v) => v.name === node.value);
	if (decl_value?.is_null) {
		add_error(status, `Variable '${node.value}' is null`, node.start);
		return false;
	}

	return true;
}
