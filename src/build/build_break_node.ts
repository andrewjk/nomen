import BreakNode from "../nodes/BreakNode.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_break_node(node: BreakNode, status: BuildStatus) {
	status.code += `break`;
}
