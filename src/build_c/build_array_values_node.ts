import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_array_values_node(node: ArrayValuesNode, status: BuildStatus) {
	status.code += `{`;
	const elem_is_string = node.type?.name === "string";
	node.values.forEach((value, i) => {
		if (i > 0) status.code += ", ";
		// A string-literal element (`"hello"`) is a read-only C string literal.
		// An array of strings takes ownership of its elements, so it must hold
		// heap copies — otherwise the scope-exit free would `free` rodata and
		// crash. strdup it (and bump the audit counter) so the element is
		// heap-owned and freeable. Mirrors the `var string x = "lit"` → strdup
		// rule in build_declaration_node.
		const is_string_literal =
			elem_is_string &&
			value.node_type === "value" &&
			(value as ValueNode).value.length >= 2 &&
			(value as ValueNode).value.startsWith('"') &&
			(value as ValueNode).value.endsWith('"');
		if (is_string_literal) {
			status.code += `nomen_str_dup(`;
			build_node(value, status);
			status.code += `)`;
		} else {
			build_node(value, status);
		}
	});
	status.code += `}`;
}
