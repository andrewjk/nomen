import type BuildStatus from "../build_c/BuildStatus.ts";
import { is_int_literal, to_decimal_string } from "../int_literal.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { find_enum_for_case } from "./utils/enum_case.ts";

function get_raw_value(node: ValueNode, status: BuildStatus): string {
	let val = node.value;
	if (val === "true") return "1";
	if (val === "false") return "0";
	if (node.is_enum_shorthand) {
		const found = find_enum_for_case(val, status);
		if (found) {
			const enum_node = found.enum_node;
			const case_name = found.case_name;
			const case_index = enum_node.cases.findIndex((c) => c.name === case_name);
			if (case_index >= 0) return String(case_index);
		}
	}
	if (is_int_literal(val)) return to_decimal_string(val);
	return val;
}

function is_literal_value(raw: string): boolean {
	return (
		is_int_literal(raw) ||
		/^(\+|-)?\d+(\.\d+)?$/.test(raw) ||
		raw === "true" ||
		raw === "false" ||
		raw.startsWith('"')
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
		// A char literal ('A') resolves to its decimal code so array-element
		// store paths can size the store by element_size (strb for char
		// arrays) instead of falling back to a generic 8-byte str.
		if (raw.startsWith("'") && raw.endsWith("'") && raw.length === 3) {
			return String(raw.charCodeAt(1));
		}
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
