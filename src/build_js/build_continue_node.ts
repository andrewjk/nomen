import type BaseNode from "../nodes/BaseNode.ts";
import { emit } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/** `continue` (loop labels are not in the v1 subset). */
export default function build_continue_node(node: BaseNode, status: BuildStatus): void {
	void node;
	emit(status, "continue;");
}
