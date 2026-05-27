import type BuildStatus from "../build/BuildStatus.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import {
	emit_destroy_for_decl,
	emit_heap_slots_cleanup_for_return,
	mark_moved_if_struct,
} from "./utils/auto_destroy.ts";
import { emit_var_store } from "./utils/stack_var.ts";

function find_var_size(name: string, status: BuildStatus): number {
	const decl = status.scoped_declarations?.find((d) => d.name === name);
	if (decl?.type?.name) {
		return aarch64_size(decl.type.name);
	}
	return 8;
}

export default function build_return_node(node: ReturnNode, status: BuildStatus) {
	if (
		node.from_c ||
		(node.value?.node_type === "value" && (node.value as any).value === '"from_c"')
	) {
		return;
	}

	if (!node.value) {
		if (status.return_assign) {
			const size = find_var_size(status.return_assign, status);
			status.code += `mov x0, #0\n`;
			emit_var_store(status, "x0", status.return_assign, size);
		} else if (status.function_return_label) {
			const finalized = status.moved ?? new Set<string>();
			for (const decl of status.scoped_declarations) {
				if (finalized.has(decl.name)) continue;
				emit_destroy_for_decl(status, decl.name, decl.type.name, undefined, decl.type.type_args);
			}
			emit_heap_slots_cleanup_for_return(status);
			status.code += `mov x0, #0\n`;
			const match_saves = status.match_save_size || 0;
			if (match_saves > 0) {
				for (let i = 0; i < match_saves; i += 16) {
					status.code += `ldr x19, [sp], #16\n`;
				}
			}
			status.code += `b ${status.function_return_label}\n`;
		}
		return;
	}

	build_node(node.value, status);
	if (status.return_assign) {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		const size = find_var_size(status.return_assign, status);
		emit_var_store(status, "x0", status.return_assign, size);
	} else if (status.function_return_label) {
		if (!status.code.endsWith("\n")) {
			status.code += "\n";
		}
		mark_moved_if_struct(node.value, status);
		const finalized = status.moved ?? new Set<string>();
		status.code += `mov x20, x0\n`;
		for (const decl of status.scoped_declarations) {
			if (finalized.has(decl.name)) continue;
			emit_destroy_for_decl(status, decl.name, decl.type.name);
		}
		emit_heap_slots_cleanup_for_return(status);
		status.code += `mov x0, x20\n`;
		const match_saves = status.match_save_size || 0;
		if (match_saves > 0) {
			for (let i = 0; i < match_saves; i += 16) {
				status.code += `ldr x19, [sp], #16\n`;
			}
		}
		status.code += `b ${status.function_return_label}\n`;
	}
}
