import ParameterNode from "../nodes/ParameterNode";
import type BuildStatus from "./BuildStatus";
import c_type from "./c_type";

export default function build_parameter_node(
  node: ParameterNode,
  status: BuildStatus,
  with_name = true,
) {
  status.code += c_type(node.type.name);
  if (with_name) {
    status.code += " ";
    status.code += node.name;
  }
}
