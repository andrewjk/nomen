import CastNode from "../nodes/CastNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";

export default function build_cast_node(node: CastNode, status: BuildStatus) {
	status.code += `(${c_type(node.target_type.name)})`;
	build_node(node.value, status);
}
