import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import MatchNode from "../nodes/MatchNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { emit_address_of } from "./build_access_node.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { allocate_stack_space } from "./utils/stack_var.ts";
import { get_enum_case_index, get_enum_payload_offset } from "./utils/struct_layout.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

function ensure_newline(status: BuildStatus) {
	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}
}

/** Extract the case tag from a match pattern node.
 *  Handles `Enum.caseName` (AccessNode), `.caseName` (ValueNode), and the
 *  mangled `Enum_caseName` form produced by the shorthand rewrite. */
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
		if (v.startsWith(".")) return v.substring(1);
		if (v.startsWith(enum_name + "_")) return v.substring(enum_name.length + 1);
	}
	return null;
}

/** Emit the case index (tag value) for a match pattern. Enum-with-data
 *  shorthand ValueNodes would otherwise build a full tag+payload temp, but
 *  the comparison only needs the tag. */
function emit_pattern_tag(match_value: BaseNode, enum_name: string, status: BuildStatus) {
	if (match_value.node_type === "value") {
		const v = match_value as ValueNode;
		const case_tag = extract_case_tag(v, enum_name);
		if (case_tag) {
			const idx = get_enum_case_index(enum_name, case_tag, status);
			status.code += `mov x0, #${idx}\n`;
			return;
		}
	}
	build_node(match_value, status);
}

export default function build_match_node(node: MatchNode, status: BuildStatus) {
	const label = label_counter++;
	const old_scoped_declarations = status.scoped_declarations;
	const old_stack_offsets = status.stack_offsets;
	status.stack_offsets = new Map(old_stack_offsets);
	const match_type = type_from_value_node(node.value);
	const match_type_name = match_type?.name;
	const enum_with_data = match_type_name
		? status.enums.find((e) => e.name === match_type_name && e.has_associated_data)
		: null;

	if (enum_with_data) {
		status.code += `stp x19, x20, [sp, #-16]!\n`;
		status.match_save_size = (status.match_save_size || 0) + 16;
	} else {
		status.code += `str x19, [sp, #-16]!\n`;
		status.match_save_size = (status.match_save_size || 0) + 16;
	}

	// For an enum with associated data we need the ADDRESS of the scrutinee
	// (so we can read its tag at +0 and payload bytes at +8…); a plain
	// build_node would load only the tag word for a bare variable reference.
	if (enum_with_data) {
		emit_address_of(node.value, status);
	} else {
		build_node(node.value, status);
	}
	ensure_newline(status);

	if (enum_with_data) {
		status.code += `mov x20, x0\n`;
		status.code += `ldr x19, [x20]\n`;
	} else {
		status.code += `mov x19, x0\n`;
	}

	// Snapshot the Buffer data-pointer cache before the match so each case
	// starts from the dominating (pre-match) state and a cache entry loaded in
	// one case is dropped on restore (sound: not valid in a sibling case).
	const pre_cache = status.buffer_data_cache;

	for (let i = 0; i < node.cases.length; i++) {
		status.scoped_declarations = [];

		// For an enum-with-data case that binds payload fields
		// (`case .fixed(x) -> …`), allocate a stack slot per binding, load the
		// payload value out of the matched enum (at x20), and bind the name to
		// that slot so the branch reads it like a local variable.
		const match_case = node.cases[i];
		if (enum_with_data && match_case.params && match_case.params.length > 0) {
			const case_tag = extract_case_tag(match_case.match_value, enum_with_data.name);
			const enum_case = case_tag
				? enum_with_data.cases.find((c) => c.name === case_tag)
				: undefined;
			if (enum_case) {
				for (let j = 0; j < match_case.params.length; j++) {
					const param_name = match_case.params[j];
					const field = enum_case.params[j];
					if (!field) continue;
					const payload_off = get_enum_payload_offset(
						enum_with_data.name,
						enum_case.name,
						field.name,
						status,
					);
					const size = aarch64_size(field.type.name);
					const slot = allocate_stack_space(status, Math.max(size, 8));
					status.stack_offsets!.set(param_name, slot);
					// Load the field value from the matched enum (base x20 +
					// payload offset) and store it into the binding's slot.
					if (size === 1) {
						status.code += `ldrb w9, [x20, #${payload_off}]\n`;
						status.code += `strb w9, [x29, #${slot}]\n`;
					} else if (size === 2) {
						status.code += `ldrh w9, [x20, #${payload_off}]\n`;
						status.code += `strh w9, [x29, #${slot}]\n`;
					} else if (size === 4) {
						status.code += `ldr w9, [x20, #${payload_off}]\n`;
						status.code += `str w9, [x29, #${slot}]\n`;
					} else {
						status.code += `ldr x9, [x20, #${payload_off}]\n`;
						status.code += `str x9, [x29, #${slot}]\n`;
					}
					// Register the binding as a scoped declaration so the branch
					// can resolve its type (e.g. for follow-up to_string).
					status.scoped_declarations.push(
						new DeclarationNode(
							match_case.match_value.start,
							"private",
							"const",
							param_name,
							field.type,
							undefined,
						),
					);
				}
			}
		}

		if (enum_with_data) {
			emit_pattern_tag(match_case.match_value, enum_with_data.name, status);
		} else {
			build_node(match_case.match_value, status);
		}
		ensure_newline(status);
		status.code += `cmp x0, x19\n`;

		if (i < node.cases.length - 1 || node.else_branch) {
			status.code += `bne case_next_${label}_${i}\n`;
		} else {
			status.code += `bne end_match_${label}\n`;
		}
		if (enum_with_data) {
			const old_param_regs = status.function_param_regs;
			const param_name = node.value.node_type === "value" ? (node.value as any).value : null;
			if (param_name && old_param_regs?.get(param_name) === "x19") {
				status.function_param_regs = new Map(old_param_regs);
				status.function_param_regs.set(param_name, "x20");
			}
			status.buffer_data_cache = new Map(pre_cache);
			build_block_node(match_case.branch, status);
			status.function_param_regs = old_param_regs;
		} else {
			status.buffer_data_cache = new Map(pre_cache);
			build_block_node(match_case.branch, status);
		}
		status.code += `b end_match_${label}\n`;

		status.code += `case_next_${label}_${i}:\n`;
	}

	if (node.else_branch) {
		status.scoped_declarations = [];
		status.buffer_data_cache = new Map(pre_cache);
		build_block_node(node.else_branch, status);
	}

	status.buffer_data_cache = pre_cache;

	status.code += `end_match_${label}:\n`;
	if (enum_with_data) {
		status.code += `ldp x19, x20, [sp], #16\n`;
		status.match_save_size = (status.match_save_size || 0) - 16;
	} else {
		status.code += `ldr x19, [sp], #16\n`;
		status.match_save_size = (status.match_save_size || 0) - 16;
	}

	status.scoped_declarations = old_scoped_declarations;
	status.stack_offsets = old_stack_offsets;
}
