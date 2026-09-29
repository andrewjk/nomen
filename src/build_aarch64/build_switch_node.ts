import type BuildStatus from "../build_c/BuildStatus.ts";
import type { NirStmt } from "../nir/nir.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import build_node from "./build_node.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import { enter_scope_frame, exit_scope_frame } from "./utils/auto_destroy.ts";
import { emit_asm } from "./utils/code_buffer.ts";

let label_counter = 0;

export function reset_label_counter() {
	label_counter = 0;
}

export default function build_switch_node(
	node: SwitchNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "switch_match" },
) {
	const label = label_counter++;
	const old_scoped_declarations = enter_scope_frame(status);
	const pre_cache = status.buffer_data_cache;
	const pre_array_cache = status.array_ptr_cache;

	// heap_string_fields records are per-path "may be heap" facts, and the
	// cases are mutually exclusive: each case (and the else branch) gets a
	// copy of the pre-switch set, or an earlier case's store made a later
	// case free the still-constructed literal as heap. The join keeps the
	// union across all cases (mirroring build_if_else_node).
	const pre_heap_string_fields = status.heap_string_fields;
	const case_field_sets: Set<string>[] = [];

	for (let i = 0; i < node.cases.length; i++) {
		status.scoped_declarations = [];

		build_node(node.cases[i].condition, status);
		emit_asm(status, `\ncmp x0, #0\n`);

		if (i < node.cases.length - 1 || node.else_branch) {
			emit_asm(status, `beq sw_next_${label}_${i}\n`);
		} else {
			emit_asm(status, `beq end_switch_${label}\n`);
		}

		status.buffer_data_cache = new Map(pre_cache);
		status.array_ptr_cache = new Map(pre_array_cache);
		status.heap_string_fields = new Set(pre_heap_string_fields ?? []);
		build_block_with_cursor(node.cases[i].branch, nir?.arms[i]?.branch, status);
		case_field_sets.push(status.heap_string_fields);
		emit_asm(status, `b end_switch_${label}\n`);

		emit_asm(status, `sw_next_${label}_${i}:\n`);
	}

	if (node.else_branch) {
		status.scoped_declarations = [];
		status.buffer_data_cache = new Map(pre_cache);
		status.array_ptr_cache = new Map(pre_array_cache);
		status.heap_string_fields = new Set(pre_heap_string_fields ?? []);
		build_block_with_cursor(node.else_branch, nir?.otherwise ?? undefined, status);
		case_field_sets.push(status.heap_string_fields);
	}

	if (case_field_sets.length > 1) {
		const merged = new Set(pre_heap_string_fields ?? []);
		for (const set of case_field_sets) {
			for (const key of set) merged.add(key);
		}
		status.heap_string_fields = merged;
	} else if (case_field_sets.length === 1) {
		status.heap_string_fields = case_field_sets[0];
	}

	status.buffer_data_cache = pre_cache;
	status.array_ptr_cache = pre_array_cache;

	emit_asm(status, `end_switch_${label}:\n`);

	exit_scope_frame(status, old_scoped_declarations);
}
