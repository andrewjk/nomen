import type BuildStatus from "../build/BuildStatus.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_var_address, emit_var_store } from "./utils/stack_var.ts";

function find_var_size(name: string, status: BuildStatus): number {
	const decl = status.scoped_declarations?.find((d) => d.name === name);
	if (decl?.type?.name) {
		return aarch64_size(decl.type.name);
	}
	return 8;
}

function emit_auto_final_before_return(status: BuildStatus, skip_var?: string) {
	const finalized = status.finalized ?? new Set<string>();
	for (const decl of status.scoped_declarations) {
		if (finalized.has(decl.name)) continue;
		if (decl.name === skip_var) continue;
		const struct_type = status.structs.find((s) => s.name === decl.type.name && !s.is_simple_type);
		if (!struct_type) continue;
		const final_func = struct_type.functions.find((f) => f.is_final);
		if (!final_func) continue;
		emit_var_address(status, "x0", decl.name);
		status.code += `bl ${struct_type.name}_${final_func.name}\n`;
	}
}

export default function build_return_node(node: ReturnNode, status: BuildStatus) {
	if (node.from_c) {
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
		let moved_var: string | undefined;
		if (node.value.node_type === "value") {
			const var_name = (node.value as ValueNode).value;
			const var_type = (node.value as ValueNode).type;
			const is_struct =
				var_type && status.structs.find((s) => s.name === var_type.name && !s.is_simple_type);
			const is_local = status.scoped_declarations.some((d) => d.name === var_name);
			if (is_struct && is_local) {
				if (!status.finalized) status.finalized = new Set<string>();
				status.finalized.add(var_name);
				moved_var = var_name;
			}
		}
		status.code += `mov x19, x0\n`;
		emit_auto_final_before_return(status, moved_var);
		status.code += `mov x0, x19\n`;
		status.code += `b ${status.function_return_label}\n`;
	}
}
