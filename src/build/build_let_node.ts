import LetNode from "../nodes/LetNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_let_node(node: LetNode, status: BuildStatus) {
	if (status.return_assign) {
		status.code += `${status.return_assign} = `;
	}
	build_node(node.value, status);
}
