import ValueNode from "../nodes/ValueNode.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_value_node(node: ValueNode, status: BuildStatus) {
	let value = node.value;
	if (value === "null") value = "0";
	else if (value === "true") value = "1";
	else if (value === "false") value = "0";
	if (value === "self" && !status.self_is_ref) {
		value = "_self";
	}
	status.code += value;
}
