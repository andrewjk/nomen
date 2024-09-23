import OperationNode from "../nodes/OperationNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";

export default function build_operation_node(node: OperationNode, status: BuildStatus) {
  build_node(node.left_value, status);
  status.code += ` ${node.op} `;
  build_node(node.right_value, status);
}
