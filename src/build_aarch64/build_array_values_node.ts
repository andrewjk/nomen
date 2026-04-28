import type BuildStatus from "../build/BuildStatus.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import ValueNode from "../nodes/ValueNode.ts";

function get_raw_value(node: ValueNode): string {
  let val = node.value;
  if (val === "true") return "1";
  if (val === "false") return "0";
  return val;
}

export default function build_array_values_node(node: ArrayValuesNode, status: BuildStatus) {
  node.values.forEach((value, i) => {
    if (i > 0) status.code += ", ";
    if (value.node_type === "value") {
      status.code += get_raw_value(value as ValueNode);
    } else {
      status.code += "/* complex */";
    }
  });
}
