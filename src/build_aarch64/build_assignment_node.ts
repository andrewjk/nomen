import AssignmentNode from "../nodes/AssignmentNode";
import ValueNode from "../nodes/ValueNode";
import type BuildStatus from "../build/BuildStatus";
import build_node from "./build_node";

export default function build_assignment_node(
  node: AssignmentNode,
  status: BuildStatus,
) {
  if (node.left_value.node_type === "value") {
    const name = (node.left_value as ValueNode).value;
    const paramReg = status.function_param_regs?.get(name);
    if (paramReg) {
      status.code += `mov x2, ${paramReg}\n`;
      build_node(node.right_value, status);
      status.code += `\nstr x0, [x2]\n`;
    } else {
      build_node(node.right_value, status);
      status.code += `\nadr x1, ${name}\nstr x0, [x1]\n`;
    }
  } else {
    build_node(node.right_value, status);
    status.code += `\n// complex assignment\n`;
  }
}
