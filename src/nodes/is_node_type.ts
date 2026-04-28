import BaseNode from "./BaseNode.ts";
import OperationNode from "./OperationNode.ts";

export function is_operation_node(node: BaseNode): node is OperationNode {
	return node.node_type === "op";
}
