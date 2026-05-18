import ValueNode from "../nodes/ValueNode.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_value_node(node: ValueNode, status: BuildStatus) {
	// TODO:
	//const value = node.type === "string" ? `"${node.value}"` : node.value;
	// HACK: Replace `self` with the dereferenced `_self`
	const value = node.value === "null" ? "0" : node.value;
	status.code += value.replace("self", "_self");
}
