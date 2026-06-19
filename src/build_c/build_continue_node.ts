import ContinueNode from "../nodes/ContinueNode.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_continue_node(node: ContinueNode, status: BuildStatus) {
	status.code += `continue`;
}
