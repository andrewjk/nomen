import type ReturnNode from "../nodes/ReturnNode.ts";
import { emit, expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/** Emit a return statement. */
export default function build_return_node(node: ReturnNode, status: BuildStatus): void {
	if (node.value) {
		emit(status, `return ${expr(node.value, status)};`);
	} else {
		emit(status, "return;");
	}
}
