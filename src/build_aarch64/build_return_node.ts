import type BuildStatus from "../build/BuildStatus.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";
import { emit_var_store } from "./utils/stack_var.ts";

function find_var_size(name: string, status: BuildStatus): number {
	const decl = status.scoped_declarations?.find((d) => d.name === name);
	if (decl?.type?.name) {
		return aarch64_size(decl.type.name);
	}
	return 8;
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
		status.code += `b ${status.function_return_label}\n`;
	}
}
