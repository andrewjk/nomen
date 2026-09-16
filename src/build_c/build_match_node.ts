import type { NirStmt } from "../nir/nir.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type EnumNode from "../nodes/EnumNode.ts";
import MatchNode from "../nodes/MatchNode.ts";
import type Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";

/**
 * Whether a case payload of this type is a class/trait REFERENCE (rides as
 * `struct Tag *` in the tagged union — see build_enum_node). The match
 * binding for such a payload must declare the pointer form, and the owning
 * payload must be reclaimed when the enum value dies.
 */
function payload_is_reference(type: Type, status: BuildStatus): boolean {
	if (!type.name || type.is_array) return false;
	const struct = status.structs.find((s) => s.name === type.name);
	if (struct?.is_class) return true;
	return !!status.traits.find((t) => t.name === type.name);
}

/** Cases of this enum whose payloads the value OWNS and must reclaim. */
function owning_payload_cases(enum_node: EnumNode, status: BuildStatus) {
	return enum_node.cases.filter((c) =>
		c.params.some((p) => p.type.name === "string" || payload_is_reference(p.type, status)),
	);
}

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

export default function build_match_node(
	node: MatchNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "switch_match" },
) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = [];

	const match_type = node.value;
	const saved_code = status.code;
	status.code = "";
	build_node(match_type, status);
	const value_expr_raw = status.code;
	status.code = saved_code;

	const enum_name = node.value_type || null;

	const enum_node = enum_name ? status.enums.find((e) => e.name === enum_name) : undefined;
	const has_associated_data = !!enum_node && enum_node.has_associated_data;

	if (!has_associated_data) {
		// Simple (non-associated) enum: emit a C switch on the tag value.
		status.code += "switch (";
		status.code += value_expr_raw;
		status.code += ") {\n";

		for (const [match_case_index, match_case] of node.cases.entries()) {
			status.scoped_declarations = [];
			status.code += "case ";
			build_node(match_case.match_value, status);
			status.code += ":\n";
			status.code += "{\n";
			build_block_with_cursor(match_case.branch, nir?.arms[match_case_index]?.branch, status);
			build_auto_free(status);
			status.code += "break;\n}\n";
		}

		if (node.else_branch) {
			status.scoped_declarations = [];
			status.code += "default:\n";
			status.code += "{\n";
			build_block_with_cursor(node.else_branch, nir?.otherwise ?? undefined, status);
			build_auto_free(status);
			status.code += "break;\n}\n";
		}

		status.code += "}\n";
		status.scoped_declarations = old_scoped_declarations;
		return;
	}

	// Associated-data enum: emit if/else-if chains comparing the tag, binding
	// each case's payload fields to the local names declared in the branch.
	// A scrutinee that is not a plain identifier (e.g. a call) must be
	// evaluated ONCE into a temp — reusing the raw expression text in each
	// case's tag test and payload binding would re-run it per case (triple
	// evaluation for a two-case match), and an enum-with-string-payload call
	// result owns heap strings that need a home for the scope-exit free.
	let value_expr = value_expr_raw;
	const scrutinee_is_identifier = match_type.node_type === "value";
	// Only CALL-shaped scrutinees become OWNED temps: their result blob would
	// otherwise point into the callee's dead frame (or be a temporary whose
	// payloads need a home). A variable/field-access scrutinee is a BORROW of
	// its owner's storage — the temp copy shares the payload pointers, and
	// freeing them at scope exit would dangle the owner's field.
	const scrutinee_is_call =
		match_type.node_type === "func_call" ||
		(match_type.node_type === "access" &&
			(match_type as AccessNode).access?.node_type === "access_func");
	let match_scrutinee_temps: string[] = [];
	if (!scrutinee_is_identifier && scrutinee_is_call && enum_name) {
		const temp = `_match_val_${match_temp_counter++}`;
		status.code += `${c_type(enum_name)} ${temp} = ${value_expr_raw};\n`;
		value_expr = temp;
		if (owning_payload_cases(enum_node!, status).length) {
			match_scrutinee_temps.push(temp);
		}
	}

	let first = true;
	for (const [match_case_index, match_case] of node.cases.entries()) {
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
				const is_ref = payload_is_reference(field.type, status);
				const decl = is_ref ? `struct ${field.type.name} *` : `${c_type(field.type.name)} `;
				status.code += `${decl}${match_case.params[i]} = ${value_expr}._data._${case_tag}.${field.name};\n`;
				if (is_ref) {
					// The binding holds the instance POINTER: track it so a
					// method call on the binding dispatches through the
					// vtable with the pointer (not its address) — mirroring
					// the trait-class local declaration machinery.
					if (!status.class_vars) status.class_vars = new Set();
					status.class_vars.add(c_function_name(match_case.params[i]));
					if (field.type.name) {
						if (!status.variable_types) status.variable_types = new Map();
						status.variable_types.set(c_function_name(match_case.params[i]), field.type);
					}
				}
			}
		}

		status.scoped_declarations = [];
		build_block_with_cursor(match_case.branch, nir?.arms[match_case_index]?.branch, status);
		build_auto_free(status);
	}

	if (node.else_branch) {
		status.code += first ? "{\n" : "} else {\n";
		status.scoped_declarations = [];
		build_block_with_cursor(node.else_branch, nir?.otherwise ?? undefined, status);
		build_auto_free(status);
	}
	status.code += "}\n";

	// The scrutinee temp dies with the match: free its owned payloads
	// (tag-guarded), mirroring the enum-local auto-free. A string payload is
	// a strdup'd copy (free the ptr); a class/trait payload is an owned
	// instance (destroy + free).
	for (const temp of match_scrutinee_temps) {
		for (const c of enum_node!.cases) {
			for (const p of c.params) {
				const is_ref = payload_is_reference(p.type, status);
				if (p.type.name !== "string" && !is_ref) continue;
				const guard = `if (${temp}.tag == ${enum_node!.name}_${c.name})`;
				if (is_ref) {
					status.code += `${guard} { ${p.type.name}_destroy(${temp}._data._${c.name}.${p.name}); free(${temp}._data._${c.name}.${p.name}); }\n`;
				} else {
					status.code += `${guard} { free(${temp}._data._${c.name}.${p.name}.ptr); }\n`;
				}
			}
		}
	}

	status.scoped_declarations = old_scoped_declarations;
}

let match_temp_counter = 0;

/** Per-build reset: builds must be deterministic per process (the NIR
 *  byte-identity tests build the same program twice). */
export function reset_match_temp_counter() {
	match_temp_counter = 0;
}
