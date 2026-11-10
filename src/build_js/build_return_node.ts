import type ReturnNode from "../nodes/ReturnNode.ts";
import { emit, expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { copy_if_value_struct, stamped_type } from "./types.ts";

/** Emit a return statement. */
export default function build_return_node(node: ReturnNode, status: BuildStatus): void {
	if (node.value) {
		// A returned struct is a fresh copy (the callee's binding stays valid).
		const value = expr(node.value, status);
		emit(status, `return ${copy_if_value_struct(value, stamped_type(node.value)?.name, status)};`);
	} else {
		emit(status, "return;");
	}
}
