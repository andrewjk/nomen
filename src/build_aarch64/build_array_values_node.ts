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
	if (val.startsWith("0x") || val.startsWith("0X"))
		return String(parseInt(val.replace(/_/g, ""), 16));
	if (val.startsWith("0o") || val.startsWith("0O"))
		return String(parseInt(val.replace(/_/g, ""), 8));
	if (val.startsWith("0b") || val.startsWith("0B"))
		return String(parseInt(val.replace(/_/g, ""), 2));
	return val;
}

function is_literal_value(raw: string): boolean {
	return (
		/^(\+|-)?\d+(\.\d+)?$/.test(raw) ||
		raw === "true" ||
		raw === "false" ||
		raw.startsWith('"') ||
		raw.startsWith("0x") ||
		raw.startsWith("0X") ||
		raw.startsWith("0o") ||
		raw.startsWith("0O") ||
		raw.startsWith("0b") ||
		raw.startsWith("0B")
	);
}

function resolve_static_value(
	node: import("../nodes/BaseNode.ts").default,
	status: BuildStatus,
): string | null {
	if (node.node_type === "value") {
		const valueNode = node as ValueNode;
		if (valueNode.is_enum_shorthand) {
			return get_raw_value(valueNode, status);
		}
		const raw = get_raw_value(valueNode, status);
		if (is_literal_value(raw)) return raw;
		return null;
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
