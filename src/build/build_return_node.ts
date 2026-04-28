import ReturnNode from "../nodes/ReturnNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_return_node(node: ReturnNode, status: BuildStatus) {
	// HACK: This needs more work to map return values to declarations
	// Remove the return value from scoped_declarations so it won't be disposed
	if (node.value.node_type === "value") {
		let value = (node.value as ValueNode).value;
		let di = status.scoped_declarations.findIndex((d) => d.name === value);
		if (di !== -1) {
			status.scoped_declarations.splice(di, 1);
		}
	}

	build_auto_free(status);

	if (status.return_assign) {
		status.code += `${status.return_assign} = `;
	} else {
		status.code += `return `;
	}
	build_node(node.value, status);
}
