import AssignmentNode from "../nodes/AssignmentNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";

export default function build_assignment_node(node: AssignmentNode, status: BuildStatus) {
  status.code += ``;
  build_node(node.left_value!, status);
  status.code += " = ";
  build_node(node.right_value!, status);
  status.code += ";\n";
}
