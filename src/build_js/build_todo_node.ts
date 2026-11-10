import type TodoNode from "../nodes/TodoNode.ts";
import { emit } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/** `todo("…")` — same runtime contract as panic. */
export default function build_todo_node(node: TodoNode, status: BuildStatus): void {
	emit(status, `__panic(${JSON.stringify(node.message ? `todo: ${node.message}` : "todo")});`);
}
