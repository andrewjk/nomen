import ValueNode from "../nodes/ValueNode";
import type BuildStatus from "./BuildStatus";

export default function build_value_node(node: ValueNode, status: BuildStatus) {
  // TODO:
  //const value = node.type === "string" ? `"${node.value}"` : node.value;
  // HACK: Replace `self` with the dereferenced `zz`
  status.code += node.value.replace("self", "zz");
}
