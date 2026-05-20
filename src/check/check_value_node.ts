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

	if (node.value.startsWith(".") && node.value.length > 1 && !node.value.startsWith("..")) {
		return check_enum_shorthand(node, status);
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

function check_enum_shorthand(node: ValueNode, status: CheckStatus): boolean {
	const case_name = node.value.substring(1);
	const expected = status.expected_type;

	if (!expected?.name) {
		add_error(status, `Cannot resolve .${case_name} without a type hint`, node.start);
		return false;
	}

	const enum_node = status.enums.find((e) => e.name === expected.name);
	if (enum_node) {
		const enum_case = enum_node.cases.find((c) => c.name === case_name);
		if (enum_case) {
			node.type = new Type(expected.name);
			node.value = `${expected.name}_${case_name}`;
			node.is_enum_shorthand = true;
			return true;
		} else {
			add_error(status, `Unknown enum case: .${case_name} on ${expected.name}`, node.start);
			return false;
		}
	}

	const bitset_node = status.bitsets.find((b) => b.name === expected.name);
	if (bitset_node) {
		if (bitset_node.cases.includes(case_name)) {
			node.type = new Type(expected.name);
			node.value = `${expected.name}_${case_name}`;
			node.is_enum_shorthand = true;
			return true;
		} else {
			add_error(status, `Unknown bitset case: .${case_name} on ${expected.name}`, node.start);
			return false;
		}
	}

	add_error(status, `Type ${expected.name} is not an enum or bitset`, node.start);
	return false;
}
