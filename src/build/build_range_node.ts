import RangeNode from "../nodes/RangeNode";
import ValueNode from "../nodes/ValueNode";
import type BuildStatus from "./BuildStatus";

export default function build_range_node(node: RangeNode, status: BuildStatus) {
  // HACK:
  const start = parseInt((node.left_value as ValueNode).value);
  const end = parseInt((node.right_value as ValueNode).value) + (node.inclusive ? 1 : 0);
  status.code += `{${[...Array(end - start).keys()].map((value) => start + value).join(", ")}}`;
}
