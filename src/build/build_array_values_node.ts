import ArrayValuesNode from "../nodes/ArrayValuesNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";

export default function build_array_values_node(node: ArrayValuesNode, status: BuildStatus) {
  status.code += `{`;
  node.values.forEach((value, i) => {
    if (i > 0) status.code += ", ";
    build_node(value, status);
  });
  status.code += `}`;
}
