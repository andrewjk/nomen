import BaseNode from "./BaseNode";
import OperationNode from "./OperationNode";

export function is_operation_node(node: BaseNode): node is OperationNode {
  return node.node_type === "op";
}
