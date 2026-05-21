import type BuildStatus from "../build/BuildStatus.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import ValueNode from "../nodes/ValueNode.ts";

function get_raw_value(node: ValueNode, status: BuildStatus): string {
	let val = node.value;
	if (val === "true") return "1";
	if (val === "false") return "0";
	if (node.is_enum_shorthand) {
		const enum_node = status.enums.find((e) => val.startsWith(e.name + "_"));
		if (enum_node) {
			const case_name = val.substring(enum_node.name.length + 1);
			const case_index = enum_node.cases.findIndex((c) => c.name === case_name);
			if (case_index >= 0) return String(case_index);
		}
	}
	return val;
}

function resolve_static_value(
	node: import("../nodes/BaseNode.ts").default,
	status: BuildStatus,
): string | null {
	if (node.node_type === "value") {
		return get_raw_value(node as ValueNode, status);
	}
	if (node.node_type === "access") {
		const access = node as AccessNode;
		if (access.access.node_type === "access_field") {
			const field = access.access as AccessFieldNode;
			if (access.target.node_type === "value") {
				const target = access.target as ValueNode;
				const enum_node = status.enums.find((e) => e.name === target.value);
				if (enum_node) {
					const case_index = enum_node.cases.findIndex((c) => c.name === field.name);
					if (case_index >= 0) return String(case_index);
				}
			}
		}
	}
	return null;
}

export { resolve_static_value };

export default function build_array_values_node(node: ArrayValuesNode, status: BuildStatus) {
	node.values.forEach((value, i) => {
		if (i > 0) status.code += ", ";
		const resolved = resolve_static_value(value, status);
		if (resolved !== null) {
			status.code += resolved;
		} else {
			status.code += "/* complex */";
		}
	});
}
