import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import MatchNode from "../nodes/MatchNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";

function enum_case_tag_name(match_value: string, enum_name: string): string | null {
	if (match_value.startsWith(enum_name + "_")) {
		return match_value.substring(enum_name.length + 1);
	}
	return null;
}

/** Extract the case tag from a match pattern node.
 *  Handles `Enum.caseName` (AccessNode) and mangled/bare value forms. */
function extract_case_tag(match_value: BaseNode, enum_name: string): string | null {
	if (match_value.node_type === "access") {
		const access = (match_value as AccessNode).access;
		if (access.node_type === "access_field") {
			return (access as AccessFieldNode).name;
		}
		return null;
	}
	if (match_value.node_type === "value") {
		const v = (match_value as ValueNode).value;
		// `.caseName` form
		if (v.startsWith(".")) return v.substring(1);
		// `Enum_caseName` mangled form
		return enum_case_tag_name(v, enum_name);
	}
	return null;
}

export default function build_match_node(node: MatchNode, status: BuildStatus) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = [];

	const match_type = node.value;
	const saved_code = status.code;
	status.code = "";
	build_node(match_type, status);
	const value_expr = status.code;
	status.code = saved_code;

	const enum_name = node.value_type || null;

	const enum_node = enum_name ? status.enums.find((e) => e.name === enum_name) : undefined;
	const has_associated_data = !!enum_node && enum_node.has_associated_data;

	if (!has_associated_data) {
		// Simple (non-associated) enum: emit a C switch on the tag value.
		status.code += "switch (";
		status.code += value_expr;
		status.code += ") {\n";

		for (const match_case of node.cases) {
			status.scoped_declarations = [];
			status.code += "case ";
			build_node(match_case.match_value, status);
			status.code += ":\n";
			status.code += "{\n";
			build_block_node(match_case.branch, status);
			build_auto_free(status);
			status.code += "break;\n}\n";
		}

		if (node.else_branch) {
			status.scoped_declarations = [];
			status.code += "default:\n";
			status.code += "{\n";
			build_block_node(node.else_branch, status);
			build_auto_free(status);
			status.code += "break;\n}\n";
		}

		status.code += "}\n";
		status.scoped_declarations = old_scoped_declarations;
		return;
	}

	// Associated-data enum: emit if/else-if chains comparing the tag, binding
	// each case's payload fields to the local names declared in the branch.
	let first = true;
	for (const match_case of node.cases) {
		const case_tag = extract_case_tag(match_case.match_value, enum_node!.name);
		if (!case_tag) continue;

		status.code += first ? "if (" : "} else if (";
		status.code += `${value_expr}.tag == ${enum_node!.name}_${case_tag}) {\n`;
		first = false;

		// Bind payload fields to the branch's local names.
		const enum_case = enum_node!.cases.find((c) => c.name === case_tag);
		if (enum_case && match_case.params) {
			for (let i = 0; i < match_case.params.length; i++) {
				const field = enum_case.params[i];
				if (!field) continue;
				status.code += `${c_type(field.type.name)} ${match_case.params[i]} = ${value_expr}._data._${case_tag}.${field.name};\n`;
			}
		}

		status.scoped_declarations = [];
		build_block_node(match_case.branch, status);
		build_auto_free(status);
	}

	if (node.else_branch) {
		status.code += first ? "{\n" : "} else {\n";
		status.scoped_declarations = [];
		build_block_node(node.else_branch, status);
		build_auto_free(status);
	}
	status.code += "}\n";

	status.scoped_declarations = old_scoped_declarations;
}
